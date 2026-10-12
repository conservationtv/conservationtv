import * as pulumi from '@pulumi/pulumi';
import type { ComposeApp, PublicTlsMaterial } from '../core/contracts';
import { assertPort, readHttpsUrl } from '../core/validate';

export const IROH_HTTPS_ENDPOINT = 'iroh.https';
export const IROH_QUIC_DISCOVERY_ENDPOINT = 'iroh.quic-discovery';
export const IROH_METRICS_ENDPOINT = 'iroh.metrics';
export const IROH_HTTP_ENDPOINT = 'iroh.http';
export const IROH_RELAY_IMAGE =
  'n0computer/iroh-relay:v1.3.0@sha256:7a51e3826531dba5eee73d8b48a8f27284684d98c4d0da271d99127cc43b9d57';

const dir = '/opt/iroh';
const containerCertPath = '/etc/iroh/certs/fullchain.pem';
const containerKeyPath = '/etc/iroh/certs/privkey.pem';

export interface IrohRelayPorts {
  https: number;
  quicDiscovery: number;
  metrics: number;
  http: number;
}

export interface IrohRelayAdmission {
  /** Gatekeeper's HTTPS `/relays/iroh/admission` endpoint. */
  url: string;
  /** Bearer token matching gatekeeper's `IROH_RELAY_TOKEN`; never distributed to clients. */
  token: pulumi.Input<string>;
}

export interface IrohRelayAppArgs {
  admission: IrohRelayAdmission;
  /** Renewals restart the relay without redeploying it. */
  tls: PublicTlsMaterial;
  /** Move HTTPS off 443 when another host-network app on the machine owns it. */
  ports?: Partial<IrohRelayPorts>;
  image?: string;
}

export function irohRelayApp(args: IrohRelayAppArgs): ComposeApp {
  const ports = readIrohRelayPorts(args.ports);
  const admissionUrl = readAdmissionUrl(readHttpsUrl(args.admission.url, 'Iroh admission URL'));
  const token = pulumi.secret(args.admission.token).apply(value => {
    if (!value.trim() || /[\r\n]/.test(value))
      throw new Error('Iroh admission token must be a non-empty bearer token.');
    return value;
  });
  return {
    name: 'iroh',
    dir,
    services: {
      relay: {
        image: args.image ?? IROH_RELAY_IMAGE,
        restart: 'unless-stopped',
        network_mode: 'host',
        pull_policy: 'always',
        environment: { IROH_RELAY_HTTP_BEARER_TOKEN: token, RUST_LOG: 'iroh_relay=info' },
        volumes: [`${dir}/iroh-relay.toml:/etc/iroh/iroh-relay.toml:ro`, `${dir}/certs:/etc/iroh/certs:ro`],
        command: ['--config-path', '/etc/iroh/iroh-relay.toml']
      }
    },
    endpoints: {
      [IROH_HTTPS_ENDPOINT]: {
        service: 'relay',
        port: ports.https,
        transport: 'tcp',
        visibility: 'public',
        scheme: 'https',
        description: 'Iroh HTTPS relay endpoint'
      },
      [IROH_QUIC_DISCOVERY_ENDPOINT]: {
        service: 'relay',
        port: ports.quicDiscovery,
        transport: 'udp',
        visibility: 'public',
        description: 'Iroh QUIC address discovery endpoint'
      },
      [IROH_METRICS_ENDPOINT]: {
        service: 'relay',
        port: ports.metrics,
        transport: 'tcp',
        visibility: 'private',
        scheme: 'http',
        paths: { metrics: '/metrics' },
        description: 'Iroh metrics endpoint'
      },
      [IROH_HTTP_ENDPOINT]: {
        service: 'relay',
        port: ports.http,
        transport: 'tcp',
        visibility: 'loopback',
        scheme: 'http',
        description: 'Iroh internal HTTP listener'
      }
    },
    files: [
      { path: `${dir}/iroh-relay.toml`, content: renderConfig(admissionUrl, ports) },
      { path: `${dir}/certs/fullchain.pem`, content: args.tls.fullchainPem, onChange: 'restart' },
      { path: `${dir}/certs/privkey.pem`, content: args.tls.privateKeyPem, mode: '0600', onChange: 'restart' }
    ],
    health: [{ url: `http://127.0.0.1:${ports.metrics}/metrics` }]
  };
}

/**
 * The relay configuration, without credentials: the bearer token travels in the environment.
 * Accepts plain HTTP admission for local development; `irohRelayApp` requires HTTPS.
 */
export function renderIrohRelayToml(admissionUrl: string, ports?: Partial<IrohRelayPorts>): string {
  return renderConfig(readAdmissionUrl(admissionUrl), readIrohRelayPorts(ports));
}

function renderConfig(admissionUrl: string, ports: IrohRelayPorts): string {
  return `enable_relay = true
http_bind_addr = "127.0.0.1:${ports.http}"
enable_quic_addr_discovery = true
enable_metrics = true
metrics_bind_addr = "[::]:${ports.metrics}"

[access.http]
url = ${JSON.stringify(admissionUrl)}

[tls]
cert_mode = "Manual"
manual_cert_path = ${JSON.stringify(containerCertPath)}
manual_key_path = ${JSON.stringify(containerKeyPath)}
https_bind_addr = "[::]:${ports.https}"
quic_bind_addr = "[::]:${ports.quicDiscovery}"
`;
}

function readAdmissionUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Iroh admission URL must use HTTP(S) without credentials or a fragment.');
  }
  return url.toString();
}

function readIrohRelayPorts(overrides: Partial<IrohRelayPorts> = {}): IrohRelayPorts {
  const ports: IrohRelayPorts = {
    https: assertPort(overrides.https ?? 443, 'Iroh https port'),
    quicDiscovery: assertPort(overrides.quicDiscovery ?? 7842, 'Iroh quicDiscovery port'),
    metrics: assertPort(overrides.metrics ?? 9090, 'Iroh metrics port'),
    http: assertPort(overrides.http ?? 8080, 'Iroh http port')
  };
  if (new Set([ports.https, ports.metrics, ports.http]).size !== 3) {
    throw new Error('Iroh HTTPS, metrics, and HTTP TCP ports must be distinct.');
  }
  return ports;
}
