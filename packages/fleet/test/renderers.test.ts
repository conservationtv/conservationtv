import { describe, expect, it } from 'vitest';
import * as pulumi from '@pulumi/pulumi';
import { parse } from 'smol-toml';
import * as yaml from 'yaml';
import type { ComposeApp } from '../src/core/contracts';
import { planComposeApp } from '../src/core/compose/lifecycle';
import { renderCloudInitYaml } from '../src/core/machines/cloudInit';
import { normalizeHostnameRoute } from '../src/core/services/cloudflareMesh';
import { moqRelayApp, renderMoqRelayToml, stableClusterId, type MoqRelayAppArgs } from '../src/moq/relayApp';
import { IROH_RELAY_IMAGE, irohRelayApp, renderIrohRelayToml, type IrohRelayAppArgs } from '../src/iroh/relayApp';

const tls = { fullchainPem: pulumi.output('public-cert'), privateKeyPem: pulumi.secret('public-key') };

function valueOf<T>(input: pulumi.Input<T>): Promise<T> {
  return new Promise(resolve => pulumi.output(input).apply(resolve));
}

function fileAt(app: ComposeApp, path: string) {
  const file = app.files?.find(candidate => candidate.path === path);
  if (!file) throw new Error(`No file at ${path}`);
  return file;
}

describe('MoQ relay app', () => {
  const args: MoqRelayAppArgs = {
    nodeId: 'relay',
    hostname: 'relay.example.test',
    peers: [],
    tls,
    auth: { origin: 'https://auth.example.test', token: 'e'.repeat(64), clusterToken: 'a'.repeat(64) }
  };
  const withAuth = (auth: Partial<MoqRelayAppArgs['auth']>) =>
    moqRelayApp({ ...args, auth: { ...args.auth, ...auth } });

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

  it('writes the cluster token as a private secret file that redeploys when it rotates', async () => {
    const tokenFile = fileAt(moqRelayApp(args), '/opt/moq/secrets/cluster-token');
    expect(tokenFile.mode).toBe('0600');
    expect(tokenFile.onChange).toBeUndefined();
    expect(await pulumi.isSecret(pulumi.output(tokenFile.content))).toBe(true);
    const rotated = fileAt(withAuth({ clusterToken: 'b'.repeat(64) }), '/opt/moq/secrets/cluster-token');
    expect(await valueOf(rotated.content)).not.toBe(await valueOf(tokenFile.content));
  });

  it('passes the auth key as secret callback credentials in the compose environment', async () => {
    const authUrl = (app: ComposeApp) => pulumi.output(app.services.relay.environment).apply(env => env.MOQ_AUTH_URL);
    const current = authUrl(moqRelayApp(args));
    expect(await pulumi.isSecret(current)).toBe(true);
    expect(await valueOf(current)).toBe(`https://moq-relay:${'e'.repeat(64)}@auth.example.test/relays/moq/admission`);
    expect(await valueOf(authUrl(withAuth({ token: 'f'.repeat(64) })))).toContain('f'.repeat(64));
    expect(() => withAuth({ origin: 'https://auth.example.test/path' })).toThrow(/origin without a path/);
  });

  it('restarts on certificate renewal and health-gates on the internal endpoints', () => {
    const app = moqRelayApp(args);
    expect(fileAt(app, '/opt/moq/certs/public/node/fullchain.pem').onChange).toBe('restart');
    expect(fileAt(app, '/opt/moq/certs/public/node/privkey.pem')).toMatchObject({ mode: '0600', onChange: 'restart' });
    expect(app.health).toEqual([
      { url: 'http://127.0.0.1:9101/health' },
      { url: 'http://127.0.0.1:9101/metrics', expect: '^# HELP moq_relay_' }
    ]);
  });
});

describe('Iroh relay app', () => {
  const args: IrohRelayAppArgs = {
    admission: { url: 'https://gatekeeper.example.test/relays/iroh/admission', token: 'callback-token' },
    tls
  };

  it('renders HTTP admission with the expected listener and TLS configuration', () => {
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

  it('keeps the callback token secret in the compose environment and requires HTTPS admission', async () => {
    const services = pulumi.output(irohRelayApp(args).services);
    expect(await pulumi.isSecret(services)).toBe(true);
    const compose = yaml.parseDocument(yaml.stringify(await valueOf(services)));
    expect(compose.getIn(['relay', 'image'])).toBe(IROH_RELAY_IMAGE);
    expect(compose.getIn(['relay', 'environment', 'IROH_RELAY_HTTP_BEARER_TOKEN'])).toBe('callback-token');
    expect(compose.getIn(['relay', 'environment', 'IROH_RELAY_ACCESS_TOKEN'])).toBeUndefined();

    const rotated = await valueOf(
      irohRelayApp({ ...args, admission: { ...args.admission, token: 'rotated' } }).services
    );
    expect(
      yaml.parseDocument(yaml.stringify(rotated)).getIn(['relay', 'environment', 'IROH_RELAY_HTTP_BEARER_TOKEN'])
    ).toBe('rotated');
    expect(() =>
      irohRelayApp({ ...args, admission: { ...args.admission, url: 'http://gatekeeper.example.test/admission' } })
    ).toThrow(/HTTPS/);
  });

  it('restarts on certificate renewal and follows port overrides into endpoints and health', () => {
    const app = irohRelayApp({ ...args, ports: { https: 8443, metrics: 9191 } });
    expect(fileAt(app, '/opt/iroh/certs/fullchain.pem').onChange).toBe('restart');
    expect(fileAt(app, '/opt/iroh/certs/privkey.pem')).toMatchObject({ mode: '0600', onChange: 'restart' });
    expect(app.endpoints?.['iroh.https']).toMatchObject({ port: 8443, visibility: 'public' });
    expect(app.health).toEqual([{ url: 'http://127.0.0.1:9191/metrics' }]);
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
  it('plans the compose file, systemd unit and app files as host claims', () => {
    const plan = planComposeApp({
      name: 'example',
      services: { app: { image: 'example@sha256:abc', container_name: 'example-app' } },
      files: [{ path: 'config.json', content: '{}' }]
    });
    expect(plan.files.map(file => [file.path, file.mode, file.onChange])).toEqual([
      ['/opt/example/docker-compose.yml', '0600', 'redeploy'],
      ['/etc/systemd/system/example.service', '0644', 'redeploy'],
      ['/opt/example/config.json', '0644', 'redeploy']
    ]);
    expect(plan.containerNames).toEqual(['example-app']);
    expect(plan.warnings).toEqual([]);
    const unit = String(plan.files[1].content);
    expect(unit).toContain('After=docker.service network-online.target');
    expect(unit).toContain('WorkingDirectory=/opt/example');
    expect(unit).toContain('ExecStart=/usr/bin/docker compose up -d --remove-orphans');
  });

  it('warns about mutable images', () => {
    const plan = planComposeApp({ name: 'example', services: { app: { image: 'example/app' } } });
    expect(plan.warnings).toEqual([expect.stringContaining('mutable image reference (example/app)')]);
  });

  it('renders the Ubuntu/Docker cloud-init profile', () => {
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
    expect(document.toJS().packages).toEqual(['jq']);
    expect(rendered).toContain('Port 2222');
    expect(rendered).toContain('PasswordAuthentication no');
    expect(rendered).toContain('docker-compose-plugin');
    expect(rendered).toContain('ssh-rsa AAAA test');
  });

  it('normalizes valid Mesh hostname routes and rejects unsupported wildcards', () => {
    expect(normalizeHostnameRoute('*.Internal.Example.Test.')).toBe('*.internal.example.test');
    expect(() => normalizeHostnameRoute('api-*.example.test')).toThrow(/wildcard|Invalid/);
    expect(() => normalizeHostnameRoute('*.*.example.test')).toThrow(/wildcard/);
  });
});
