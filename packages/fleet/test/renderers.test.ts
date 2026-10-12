import { describe, expect, it } from 'vitest';
import * as pulumi from '@pulumi/pulumi';
import { parse } from 'smol-toml';
import { renderRemoteFileManifest } from '../src/core/host/remote';
import { composeUnit } from '../src/core/host/systemd';
import { composeHostClaims, healthCheckLoop } from '../src/core/host/composeHost';
import { stableClusterId } from '../src/moq/cluster';
import { moqRelayApp, renderMoqRelayToml } from '../src/moq/relayApp';
import { IROH_RELAY_IMAGE, irohRelayApp, renderIrohRelayToml } from '../src/iroh/relayApp';
import { renderCloudInitYaml } from '../src/core/host/cloudInit';
import * as yaml from 'yaml';
import { normalizeHostnameRoute } from '../src/core/addons/cloudflareMesh';

describe('workload renderers', () => {
  it('preserves stable MoQ cluster ids', () => {
    expect(stableClusterId('na-east')).toBe('1050655469914659');
    expect(stableClusterId('fr')).toBe('2161155630414602');
  });

  it('renders static MoQ peers with a token file and no client certificate or auth credential', () => {
    const peers = ['https://eu-west.nodes.moq.example.test/'];
    const config = parse(renderMoqRelayToml('na-east', 'na-east.nodes.moq.example.test', peers));
    expect(config.auth).toBeUndefined();
    expect(config.connect).toBeUndefined();
    expect(config.cluster).toEqual({
      id: 1050655469914659,
      node: 'https://na-east.nodes.moq.example.test/',
      connect: peers,
      token: '/etc/moq/secrets/cluster-token'
    });
    expect(config.listen).toEqual({
      bind: '[::]:443',
      tls: { cert: '/etc/moq/certs/public/node/fullchain.pem', key: '/etc/moq/certs/public/node/privkey.pem' }
    });
    expect(config.web).toEqual({
      https: {
        listen: '[::]:443',
        cert: '/etc/moq/certs/public/node/fullchain.pem',
        key: '/etc/moq/certs/public/node/privkey.pem'
      }
    });
  });

  const moqArgs = {
    nodeId: 'relay',
    hostname: 'relay.example.test',
    authOrigin: 'https://auth.example.test',
    authToken: 'e'.repeat(64),
    peers: [],
    clusterToken: 'a'.repeat(64),
    publicTls: { fullchainPem: pulumi.output('public-cert'), privateKeyPem: pulumi.secret('public-key') }
  };

  async function redeploysOn(overrides: Partial<typeof moqArgs>): Promise<boolean> {
    const before = pulumi.output(moqRelayApp(moqArgs).deploySteps[0].triggers);
    const after = pulumi.output(moqRelayApp({ ...moqArgs, ...overrides }).deploySteps[0].triggers);
    expect(await pulumi.isSecret(before)).toBe(true);
    expect(await pulumi.isSecret(after)).toBe(true);
    return new Promise<boolean>(resolve => {
      pulumi.all([before, after]).apply(([left, right]) => resolve(JSON.stringify(left) !== JSON.stringify(right)));
    });
  }

  it('keeps the MoQ cluster token secret, writes it privately and redeploys on rotation', async () => {
    const app = moqRelayApp(moqArgs);
    const tokenFile = app.files?.find(file => file.path === '/opt/moq/secrets/cluster-token');
    expect(tokenFile?.permissions).toBe('0600');
    expect(await pulumi.isSecret(pulumi.output(tokenFile?.content))).toBe(true);
    expect(await redeploysOn({ clusterToken: 'b'.repeat(64) })).toBe(true);
  });

  it('passes the MoQ auth key as secret callback credentials and redeploys on rotation', async () => {
    const authUrl = pulumi.output(moqRelayApp(moqArgs).services.relay?.environment?.MOQ_AUTH_URL);
    expect(await pulumi.isSecret(authUrl)).toBe(true);
    const url = await new Promise<string>(resolve => authUrl.apply(value => resolve(String(value))));
    expect(url).toBe(`https://moq-relay:${'e'.repeat(64)}@auth.example.test/relays/moq/admission`);
    expect(await redeploysOn({ authToken: 'f'.repeat(64) })).toBe(true);
  });

  it('renders Iroh HTTP admission with the expected listener and TLS configuration', () => {
    const admissionUrl = 'https://gatekeeper.example.test/relays/iroh/admission';
    const config = parse(renderIrohRelayToml(admissionUrl));
    expect(config.access).toEqual({ http: { url: admissionUrl } });
    expect(config.tls).toMatchObject({
      cert_mode: 'Manual',
      https_bind_addr: '[::]:443',
      quic_bind_addr: '[::]:7842'
    });
    expect(config.metrics_bind_addr).toBe('[::]:9090');

    const sharedNodeConfig = parse(renderIrohRelayToml(admissionUrl, { https: 8443 }));
    expect(sharedNodeConfig.tls).toMatchObject({ https_bind_addr: '[::]:8443' });
    expect(() => renderIrohRelayToml(admissionUrl, { https: 9090 })).toThrow(/TCP ports must be distinct/);
  });

  it('keeps the Iroh callback token secret in Compose and redeploys when the token rotates', async () => {
    const args = {
      hostname: 'london.nodes.iroh.example.test',
      admissionUrl: 'https://gatekeeper.example.test/relays/iroh/admission',
      admissionToken: 'callback-token',
      publicTls: { fullchainPem: pulumi.output('certificate'), privateKeyPem: pulumi.secret('key') }
    };
    const app = irohRelayApp(args);
    const services = pulumi.output(app.services);
    expect(await pulumi.isSecret(services)).toBe(true);
    const compose = yaml.parseDocument(
      await new Promise<string>(resolve => {
        services.apply(value => resolve(yaml.stringify(value)));
      })
    );
    expect(compose.getIn(['relay', 'image'])).toBe(IROH_RELAY_IMAGE);
    expect(compose.getIn(['relay', 'environment', 'IROH_RELAY_HTTP_BEARER_TOKEN'])).toBe(args.admissionToken);
    expect(compose.getIn(['relay', 'environment', 'IROH_RELAY_ACCESS_TOKEN'])).toBeUndefined();

    const triggers = pulumi.output(app.deploySteps[0].triggers);
    const rotated = pulumi.output(irohRelayApp({ ...args, admissionToken: 'rotated-token' }).deploySteps[0].triggers);
    expect(await pulumi.isSecret(triggers)).toBe(true);
    expect(await pulumi.isSecret(rotated)).toBe(true);
    const changed = await new Promise<boolean>(resolve => {
      pulumi
        .all([triggers, rotated])
        .apply(([before, after]) => resolve(JSON.stringify(before) !== JSON.stringify(after)));
    });
    expect(changed).toBe(true);
    expect(() =>
      irohRelayApp({ ...args, admissionUrl: 'http://gatekeeper.example.test/relays/iroh/admission' })
    ).toThrow(/HTTPS/);
  });

  it('rejects non-HTTP callback URLs, embedded credentials and fragments', () => {
    expect(() => renderIrohRelayToml('file:///tmp/admission')).toThrow(/HTTP/);
    expect(() => renderIrohRelayToml('https://user:password@example.test/admission')).toThrow(/credentials/);
    expect(() => renderIrohRelayToml('https://example.test/admission#fragment')).toThrow(/fragment/);
    expect(parse(renderIrohRelayToml('http://127.0.0.1:8080/relays/iroh/admission')).access).toEqual({
      http: { url: 'http://127.0.0.1:8080/relays/iroh/admission' }
    });
  });
});

describe('host renderers', () => {
  it('batches files into a permission-preserving manifest', () => {
    const script = renderRemoteFileManifest([
      { path: '/opt/example/config.txt', content: 'hello\n', permissions: '0600' },
      { path: '/etc/systemd/system/example.service', content: '[Unit]\n', permissions: '0644' }
    ]);
    expect(script).toContain("install -m 0755 -d '/opt/example'");
    expect(script).toContain(Buffer.from('hello\n').toString('base64'));
    expect(script).toContain("chmod 0600 '/opt/example/config.txt'");
    expect(script.match(/base64 -d/g)).toHaveLength(2);
  });

  it('rejects unsafe manifest paths and modes', () => {
    expect(() => renderRemoteFileManifest([{ path: 'relative', content: 'x', permissions: '0644' }])).toThrow(
      /absolute/
    );
    expect(() => renderRemoteFileManifest([{ path: '/tmp/x', content: 'x', permissions: '999' }])).toThrow(
      /permissions/
    );
  });

  it('renders systemd and health-gate scripts', () => {
    const unit = composeUnit('Example', '/opt/example', ['app']);
    expect(unit).toContain('After=docker.service network-online.target');
    expect(unit).toContain("docker compose -f /opt/example/docker-compose.yml up -d --remove-orphans 'app'");
    const health = healthCheckLoop({
      url: 'http://127.0.0.1:9101/health',
      expectGrep: { url: 'http://127.0.0.1:9101/metrics', pattern: '^# HELP' },
      logsOnFailure: 'docker logs relay'
    });
    expect(health).toContain('seq 1 30');
    expect(health).toContain("grep -q '^# HELP'");
    expect(health).toContain('docker logs relay');
  });

  it('collects host paths and explicit container names for cross-workload validation', () => {
    const claims = composeHostClaims({
      name: 'example',
      dir: '/opt/example',
      services: { app: { image: 'example@sha256:abc', container_name: 'example-app' } },
      files: [{ path: '/opt/example/config.json', content: '{}' }],
      systemdUnits: [{ path: '/etc/systemd/system/example.service', content: '[Unit]' }],
      deploySteps: []
    });
    expect(claims.paths).toEqual([
      '/opt/example/docker-compose.yml',
      '/opt/example/config.json',
      '/etc/systemd/system/example.service'
    ]);
    expect(claims.containerNames).toEqual(['example-app']);
  });

  it('renders the Ubuntu/Docker cloud-init profile used by the reference deployment', () => {
    const rendered = renderCloudInitYaml({
      hostname: 'na-east',
      fqdn: 'na-east.nodes.example.test',
      ssh: { port: 2222, allowedCidrs: ['192.0.2.0/24'] },
      sshAuthorizedKeys: ['ssh-rsa AAAA test'],
      extraPackages: ['jq']
    });
    const document = yaml.parseDocument(rendered);
    expect(document.get('hostname')).toBe('na-east');
    expect(document.get('fqdn')).toBe('na-east.nodes.example.test');
    expect(rendered).toContain('- jq');
    expect(rendered).toContain('Port 2222');
    expect(rendered).toContain('docker-compose-plugin');
    expect(rendered).toContain('ssh-rsa AAAA test');
  });

  it('normalizes valid Mesh hostname routes and rejects unsupported wildcards', () => {
    expect(normalizeHostnameRoute('*.Internal.Example.Test.')).toBe('*.internal.example.test');
    expect(() => normalizeHostnameRoute('api-*.example.test')).toThrow(/wildcard|Invalid/);
    expect(() => normalizeHostnameRoute('*.*.example.test')).toThrow(/wildcard/);
  });
});
