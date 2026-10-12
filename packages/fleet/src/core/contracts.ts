import type { types as commandTypes } from '@pulumi/command';
import type * as pulumi from '@pulumi/pulumi';

/**
 * The vocabulary every component in this package exchanges.
 *
 * Components are composed the Pulumi way: `new X(name, args, opts)`, with relationships
 * expressed by passing one component's outputs as another's args. No component calls a
 * method on another to create resources in its tree or change its behaviour. The single
 * deliberate exception is `HostClaimLedger`, which is append-only, validation-only and
 * order-independent: it can reject a program, never alter what gets built.
 */

// ── Network policy ──────────────────────────────────────────────────────────────────

export type FirewallProtocol = 'tcp' | 'udp' | 'icmp';

export interface PortRange {
  from: number;
  to: number;
}

/** Allow `protocol` traffic on `port` (all ports when omitted) from `sourceCidrs`. */
export interface FirewallRule {
  protocol: FirewallProtocol;
  port?: number | PortRange;
  sourceCidrs: string[];
}

// ── Fleet and machines ──────────────────────────────────────────────────────────────

export interface SshAccess {
  /** Non-standard SSH port; 22 is rejected. */
  port: number;
  allowedCidrs: string[];
}

/** What a machine needs from its fleet: naming, SSH policy and the bootstrap key. */
export interface FleetContext {
  readonly namePrefix: string;
  readonly environment: string;
  readonly ssh: SshAccess;
  readonly publicKeyOpenSsh: pulumi.Output<string>;
  readonly privateKeyPem: pulumi.Output<string>;
}

/**
 * Where additional firewall rules attach on an existing machine. A deployment creates a
 * `MachineIngress` component under itself with this target; it never asks the machine to.
 */
export type FirewallTarget =
  | { kind: 'digitalocean'; dropletId: pulumi.Output<number>; cloudName: string }
  | { kind: 'openstack'; securityGroupId: pulumi.Output<string>; region: string };

/** Plan-time host resources a deployment occupies on a machine. */
export interface HostClaims {
  /** `${transport}:${port}` for every host-bound listener. */
  listeners: string[];
  /** Absolute remote paths written, including the compose file and systemd units. */
  paths: string[];
  /** Explicit compose `container_name` values. */
  containerNames: string[];
}

/** Rejects overlapping claims from different owners on one machine. Order-independent. */
export interface HostClaimLedger {
  claim(owner: string, claims: HostClaims): void;
}

/** A provisioned VPS. Implemented by concrete components such as `DigitalOceanMachine`. */
export interface Machine {
  /** Logical id: a lowercase DNS label, unique within the fleet. */
  readonly id: string;
  /** Human-readable place name used in directories. Defaults to `id`. */
  readonly displayName: string;
  /** Provider name, e.g. `digitalocean` or `openstack`. */
  readonly provider: string;
  readonly region: string;
  /** The machine's own hostname/FQDN, set at creation. Workload hostnames are DNS aliases. */
  readonly hostname: string;
  readonly address: pulumi.Output<string>;
  readonly addressV6?: pulumi.Output<string>;
  /** SSH connection for deployment commands (deployment user, fleet key, fleet SSH port). */
  readonly connection: pulumi.Output<commandTypes.input.remote.ConnectionArgs>;
  /** True when the deployment user is not root, so remote scripts run through sudo. */
  readonly sudo: boolean;
  /** Completes once cloud-init has finished. Remote work must depend on it. */
  readonly ready: pulumi.Resource;
  readonly firewall: FirewallTarget;
  readonly claims: HostClaimLedger;
}

// ── Service endpoints ───────────────────────────────────────────────────────────────

export type EndpointTransport = 'tcp' | 'udp';
export type EndpointVisibility = 'public' | 'private' | 'loopback';
/** `host`: the listener is bound on the machine (host network or published port). */
export type EndpointBinding = 'host' | 'compose';

export interface ServiceEndpointDefinition {
  service: string;
  port: number;
  targetPort?: number;
  transport: EndpointTransport;
  visibility: EndpointVisibility;
  binding?: EndpointBinding;
  scheme?: string;
  paths?: Record<string, string>;
  description?: string;
  /** Public endpoints only. Defaults to anywhere. */
  sourceCidrs?: string[];
}

export interface ServiceEndpoint extends ServiceEndpointDefinition {
  id: string;
  /** The app that declared it. */
  owner: string;
  binding: EndpointBinding;
  targetPort: number;
}

// ── Compose applications ────────────────────────────────────────────────────────────

export type ComposeValue =
  | string
  | number
  | boolean
  | null
  | pulumi.Input<string>
  | ComposeMapping
  | ComposeValue[];

export interface ComposeMapping {
  readonly [key: string]: ComposeValue;
}

/**
 * How a file change rolls out:
 * - `redeploy` (default): pull and recreate the app's services.
 * - `restart`: restart services in place (e.g. renewed certificates).
 * - `none`: write the file only.
 */
export type FileChangePolicy = 'redeploy' | 'restart' | 'none';

export interface RemoteFile {
  /** Absolute path, or relative to the app directory. */
  path: string;
  content: pulumi.Input<string>;
  /** Octal mode. Defaults to `0644`. */
  mode?: string;
  onChange?: FileChangePolicy;
}

export interface HealthCheck {
  /** Fetched from the machine itself, e.g. `http://127.0.0.1:9101/health`. */
  url: string;
  /** Extended regex the response body must match. */
  expect?: string;
}

/** An extra remote step. Runs in the app directory after the managed lifecycle. */
export interface DeployStep {
  name: string;
  script: pulumi.Input<string>;
  triggers: pulumi.Input<unknown>[];
}

/**
 * One Docker Compose project on one machine.
 *
 * The lifecycle is managed: the compose file, a systemd unit, pull/up on redeploy,
 * restart on `restart` files, and health gating after either are generated from this
 * description. Apps state what they are, not how to install themselves.
 */
export interface ComposeApp {
  /** Sanitized name; also the compose project and systemd unit name. */
  name: string;
  /** Absolute directory. Defaults to `/opt/<name>`. */
  dir?: string;
  services: Record<string, ComposeMapping>;
  volumes?: Record<string, ComposeMapping>;
  endpoints?: Record<string, ServiceEndpointDefinition>;
  files?: RemoteFile[];
  /** Checked after every redeploy or restart; all must pass. */
  health?: HealthCheck[];
  /** Escape hatch for work the managed lifecycle does not cover. */
  steps?: DeployStep[];
}

// ── Workloads ───────────────────────────────────────────────────────────────────────

export interface PublicTlsMaterial {
  fullchainPem: pulumi.Output<string>;
  privateKeyPem: pulumi.Output<string>;
}

/** Address records are created for each deployment's hostname when supplied. */
export interface DnsZone {
  provider: 'cloudflare';
  zoneId: pulumi.Input<string>;
  /** Defaults to 60 seconds. */
  ttl?: number;
}

/** One placement of a workload: which machine, under which public hostname. */
export interface WorkloadTarget {
  machine: Machine;
  hostname: string;
  /** Rollout and directory order; lower first, ties by machine id. Defaults to 0. */
  priority?: number;
}

export type Rollout = 'parallel' | 'serial';

export interface ComposeDeploymentArgs {
  target: WorkloadTarget;
  app: ComposeApp;
  /** Extra rules beyond those implied by public host endpoints. */
  ingress?: FirewallRule[];
  dns?: DnsZone;
}

export interface ComposeWorkloadArgs {
  targets: WorkloadTarget[];
  app: ComposeApp | ((target: WorkloadTarget) => ComposeApp);
  ingress?: FirewallRule[];
  dns?: DnsZone;
  /** `serial` health-gates each target before the next starts. Defaults to `parallel`. */
  rollout?: Rollout;
}

export interface DeploymentSummary {
  machine: string;
  provider: string;
  region: string;
  hostname: string;
  address: string;
  addressV6?: string;
  endpoints: Record<string, ServiceEndpoint>;
}
