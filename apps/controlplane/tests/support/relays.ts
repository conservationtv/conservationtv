import { GenericContainer, Network, type StartedTestContainer, Wait } from 'testcontainers';
import { IROH_RELAY_IMAGE, renderIrohRelayToml } from '@moq-ha/vps-fleet/iroh';
import { parse, stringify } from 'smol-toml';
import { MOQ_CLUSTER_TOKEN, MOQ_RELAY_TOKEN } from '@conservationtv/gatekeeper/testing';
import { MOQ_RELAY_IMAGE, moqAuthUrl, renderMoqRelayToml } from '@moq-ha/vps-fleet/moq';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DOCKER_HOST, DOCKER_HOST_ENTRY, type GatekeeperServer } from './gatekeeper.ts';

const SOCAT_IMAGE = 'alpine/socat:1.8.1.3';

const MOQ_WEB_PORT = 4443;
const MOQ_AUTH_PORT = 4440;
const IROH_HTTP_PORT = 3340;
/** The socat sidecar's loopback listener, carrying the relay key as production's https auth URL does. */
const moqLoopbackAuthUrl = (relayToken: string) => moqAuthUrl(`http://127.0.0.1:${MOQ_AUTH_PORT}`, relayToken);

export interface StartedRelay {
  /** The relay's HTTP origin as the test process reaches it. */
  url: string;
  stop(): Promise<void>;
}

/**
 * moq-relay with gatekeeper as its `--auth-url`. The relay only accepts `http://` auth URLs on loopback (production
 * uses https), so a socat sidecar sharing the relay's network namespace forwards its loopback port to the gatekeeper.
 */
export async function startMoqRelay(gatekeeper: GatekeeperServer, relayToken = MOQ_RELAY_TOKEN): Promise<StartedRelay> {
  const relay = await new GenericContainer(MOQ_RELAY_IMAGE)
    .withEnvironment({
      MOQ_LISTEN: '[::]:4433',
      MOQ_LISTEN_TLS_GENERATE: 'localhost',
      MOQ_WEB_HTTP_LISTEN: `[::]:${MOQ_WEB_PORT}`,
      MOQ_STATS_NODE: 'relay-1',
      MOQ_AUTH_URL: moqLoopbackAuthUrl(relayToken)
    })
    .withExtraHosts([DOCKER_HOST_ENTRY])
    .withExposedPorts(MOQ_WEB_PORT)
    .withWaitStrategy(Wait.forHttp('/health', MOQ_WEB_PORT))
    .start();
  const { port } = new URL(gatekeeper.containerUrl);
  const sidecar = await new GenericContainer(SOCAT_IMAGE)
    .withNetworkMode(`container:${relay.getId()}`)
    .withCommand([`TCP-LISTEN:${MOQ_AUTH_PORT},fork,reuseaddr,bind=127.0.0.1`, `TCP:${DOCKER_HOST}:${port}`])
    .start();
  return {
    url: `http://${relay.getHost()}:${relay.getMappedPort(MOQ_WEB_PORT)}`,
    stop: async () => {
      await sidecar.stop();
      await relay.stop();
    }
  };
}

/** iroh-relay in dev mode (plain HTTP), with gatekeeper as its `access.http` callout. */
export async function startIrohRelay(gatekeeper: GatekeeperServer, bearerToken: string): Promise<StartedRelay> {
  const config = parse(renderIrohRelayToml(`${gatekeeper.containerUrl}/relays/iroh/admission`));
  // Use the production auth configuration; local containers expose plain HTTP without public TLS or QUIC discovery.
  config.http_bind_addr = `0.0.0.0:${IROH_HTTP_PORT}`;
  config.enable_quic_addr_discovery = false;
  delete config.tls;
  const relay: StartedTestContainer = await new GenericContainer(IROH_RELAY_IMAGE)
    .withCopyContentToContainer([{ content: stringify(config), target: '/config.toml' }])
    .withEnvironment({ IROH_RELAY_HTTP_BEARER_TOKEN: bearerToken })
    .withCommand(['--dev', '--config-path', '/config.toml'])
    .withExtraHosts([DOCKER_HOST_ENTRY])
    .withExposedPorts(IROH_HTTP_PORT)
    .withWaitStrategy(Wait.forHttp('/', IROH_HTTP_PORT))
    .start();
  return {
    url: `http://${relay.getHost()}:${relay.getMappedPort(IROH_HTTP_PORT)}`,
    stop: async () => {
      await relay.stop();
    }
  };
}

export interface StartedMoqPeers {
  stop(): Promise<void>;
}

/** Exercise static peers and the token file over server-authenticated TLS; the CA stands in for public ACME. */
export async function startMoqPeers(
  gatekeeper: GatekeeperServer,
  clusterToken = MOQ_CLUSTER_TOKEN
): Promise<StartedMoqPeers> {
  const directory = await mkdtemp(join(tmpdir(), 'moq-peer-token-'));
  const run = promisify(execFile);
  const network = await new Network().start();
  const containers: StartedTestContainer[] = [];
  const stop = async () => {
    for (const container of containers.toReversed()) await container.stop();
    await network.stop();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-days',
        '1',
        '-subj',
        '/CN=MoQ test CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE'
      ],
      { cwd: directory }
    );
    await run(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        'node.key',
        '-out',
        'node.csr',
        '-subj',
        '/CN=peer',
        '-addext',
        'subjectAltName=DNS:peer-a,DNS:peer-b',
        '-addext',
        'extendedKeyUsage=serverAuth'
      ],
      { cwd: directory }
    );
    await run(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        'node.csr',
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        'node.pem',
        '-days',
        '1',
        '-copy_extensions',
        'copy'
      ],
      { cwd: directory }
    );
    const [ca, cert, key] = await Promise.all(
      ['ca.pem', 'node.pem', 'node.key'].map(file => readFile(join(directory, file), 'utf8'))
    );
    for (const [node, peers] of [
      ['peer-b', []],
      ['peer-a', ['https://peer-b/']]
    ] as const) {
      const config = parse(renderMoqRelayToml(node, node, [...peers]));
      config.auth = { url: moqLoopbackAuthUrl(MOQ_RELAY_TOKEN) };
      config.connect = {
        tls: {
          root: ['/test-server-ca.pem']
        }
      };
      config.internal = { listen: '0.0.0.0:9101' };
      const relay = await new GenericContainer(MOQ_RELAY_IMAGE)
        .withNetwork(network)
        .withNetworkAliases(node)
        .withExtraHosts([DOCKER_HOST_ENTRY])
        .withCopyContentToContainer([
          { content: stringify(config), target: '/etc/moq/relay.toml' },
          { content: ca!, target: '/test-server-ca.pem' },
          { content: clusterToken, target: '/etc/moq/secrets/cluster-token' },
          { content: cert!, target: '/etc/moq/certs/public/node/fullchain.pem' },
          { content: key!, target: '/etc/moq/certs/public/node/privkey.pem' }
        ])
        .withCommand(['/etc/moq/relay.toml'])
        .withExposedPorts(9101)
        .withWaitStrategy(Wait.forHttp('/health', 9101))
        .start();
      containers.push(relay);
      const sidecar = await new GenericContainer(SOCAT_IMAGE)
        .withNetworkMode(`container:${relay.getId()}`)
        .withCommand([
          `TCP-LISTEN:${MOQ_AUTH_PORT},fork,reuseaddr,bind=127.0.0.1`,
          `TCP:${DOCKER_HOST}:${new URL(gatekeeper.containerUrl).port}`
        ])
        .start();
      containers.push(sidecar);
    }
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
