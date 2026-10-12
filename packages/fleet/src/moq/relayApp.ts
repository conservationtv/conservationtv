import { createHash } from 'node:crypto';
import * as pulumi from '@pulumi/pulumi';
import type { ComposeApp, PublicTlsMaterial } from '../core/contracts';
import { readHttpsUrl } from '../core/validate';

export const MOQ_RELAY_IMAGE = 'moqdev/moq-relay:0.17.2';
export const MOQ_HTTPS_ENDPOINT = 'moq.https';
export const MOQ_WEBTRANSPORT_ENDPOINT = 'moq.webtransport';
export const MOQ_PROMETHEUS_ENDPOINT = 'moq.prometheus';

const dir = '/opt/moq';
// QUIC (WebTransport) and HTTPS share one port; the listeners in relay.toml and the endpoints derive from it.
const publicPort = 443;
const internalPort = 9101;
const containerCertPath = '/etc/moq/certs/public/node/fullchain.pem';
const containerKeyPath = '/etc/moq/certs/public/node/privkey.pem';
const containerClusterTokenPath = '/etc/moq/secrets/cluster-token';

export interface MoqRelayAuth {
  /** HTTPS origin of the admission service relays call back to, without a path. */
  origin: string;
  /** Shared key relays present on admission callbacks (gatekeeper's `MOQ_RELAY_TOKEN`). */
  token: pulumi.Input<string>;
  /** Shared peer credential, 32 bytes as lowercase hex (gatekeeper's `MOQ_CLUSTER_TOKEN`). */
  clusterToken: pulumi.Input<string>;
}

export interface MoqRelayAppArgs {
  /** Stable relay id: seeds the cluster id and names the stats node. */
  nodeId: string;
  /** Public hostname the relay serves and advertises to its peers. */
  hostname: string;
  /** Node URLs of the relays this one dials. */
  peers: string[];
  tls: PublicTlsMaterial;
  auth: MoqRelayAuth;
  image?: string;
}

/** The admission callback URL, carrying `authToken` as userinfo so moq-relay sends it as HTTP Basic credentials. */
export function moqAuthUrl(authOrigin: string, authToken: string): string {
  const url = new URL('/relays/moq/admission', authOrigin);
  url.username = 'moq-relay';
  url.password = authToken;
  return url.toString();
}

export function moqNodeUrl(hostname: string): string {
  return `https://${hostname}/`;
}

/** A non-zero id that fits in a JavaScript safe integer, which is what moq-relay's TOML parser accepts. */
export function stableClusterId(value: string): string {
  const bytes = createHash('sha256').update(value).digest();
  let id = 0n;
  for (const byte of bytes.subarray(0, 7)) id = (id << 8n) | BigInt(byte);
  id &= (1n << 53n) - 1n;
  return (id === 0n ? 1n : id).toString();
}

export function moqRelayApp(args: MoqRelayAppArgs): ComposeApp {
  const origin = readAuthOrigin(args.auth.origin);
  // An environment variable in the private compose file: relay.toml is world-readable.
  const authUrl = pulumi.secret(args.auth.token).apply(token => {
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('MoQ auth token must be a non-empty single-line key.');
    return moqAuthUrl(origin, token);
  });
  const clusterToken = pulumi.secret(args.auth.clusterToken).apply(token => {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('MoQ cluster token must be 32 bytes encoded as lowercase hex.');
    return token;
  });
  return {
    name: 'moq',
    dir,
    services: {
      relay: {
        image: args.image ?? MOQ_RELAY_IMAGE,
        restart: 'unless-stopped',
        network_mode: 'host',
        pull_policy: 'always',
        ulimits: { nofile: { soft: 65536, hard: 65536 } },
        environment: { MOQ_AUTH_URL: authUrl },
        volumes: [
          `${dir}/relay.toml:/etc/moq/relay.toml:ro`,
          `${dir}/certs:/etc/moq/certs:ro`,
          `${dir}/secrets:/etc/moq/secrets:ro`
        ],
        command: ['/etc/moq/relay.toml']
      }
    },
    endpoints: {
      [MOQ_HTTPS_ENDPOINT]: {
        service: 'relay',
        port: publicPort,
        transport: 'tcp',
        visibility: 'public',
        scheme: 'https',
        paths: { health: '/health' },
        description: 'MoQ HTTPS relay endpoint'
      },
      [MOQ_WEBTRANSPORT_ENDPOINT]: {
        service: 'relay',
        port: publicPort,
        transport: 'udp',
        visibility: 'public',
        scheme: 'https',
        description: 'MoQ WebTransport endpoint'
      },
      [MOQ_PROMETHEUS_ENDPOINT]: {
        service: 'relay',
        port: internalPort,
        transport: 'tcp',
        visibility: 'private',
        scheme: 'http',
        paths: { health: '/health', metrics: '/metrics' },
        description: 'MoQ Prometheus metrics and internal health endpoint'
      }
    },
    files: [
      { path: `${dir}/relay.toml`, content: renderMoqRelayToml(args.nodeId, args.hostname, args.peers) },
      { path: `${dir}/secrets/cluster-token`, content: clusterToken, mode: '0600' },
      { path: `${dir}/certs/public/node/fullchain.pem`, content: args.tls.fullchainPem, onChange: 'restart' },
      {
        path: `${dir}/certs/public/node/privkey.pem`,
        content: args.tls.privateKeyPem,
        mode: '0600',
        onChange: 'restart'
      }
    ],
    health: [
      { url: `http://127.0.0.1:${internalPort}/health` },
      { url: `http://127.0.0.1:${internalPort}/metrics`, expect: '^# HELP moq_relay_' }
    ]
  };
}

/** The relay configuration. Carries no credentials: the auth URL travels in the environment, the cluster token in a file. */
export function renderMoqRelayToml(nodeId: string, hostname: string, peers: string[]): string {
  const listen = JSON.stringify(`[::]:${publicPort}`);
  const cert = JSON.stringify(containerCertPath);
  const key = JSON.stringify(containerKeyPath);
  return `[listen]
bind = ${listen}

[listen.tls]
cert = ${cert}
key = ${key}

[web.https]
listen = ${listen}
cert = ${cert}
key = ${key}

[cluster]
id = ${stableClusterId(nodeId)}
node = ${JSON.stringify(moqNodeUrl(hostname))}
connect = ${JSON.stringify(peers)}
token = ${JSON.stringify(containerClusterTokenPath)}

[stats]
enabled = true
node = ${JSON.stringify(nodeId)}

[internal]
listen = "127.0.0.1:${internalPort}"
`;
}

function readAuthOrigin(value: string): string {
  const origin = readHttpsUrl(value, 'MoQ auth origin');
  if (new URL(origin).origin !== origin) throw new Error('MoQ auth origin must be an HTTPS origin without a path.');
  return origin;
}
