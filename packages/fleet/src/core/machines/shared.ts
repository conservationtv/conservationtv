import { remote, type types as commandTypes } from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import type { FirewallRule, FleetContext } from '../contracts';
import { DEFAULT_EGRESS } from '../firewall';
import { resourceName, truncateWithHash } from '../naming';
import { asRemoteScript } from '../shell';
import { assertDnsLabel, readHostname } from '../validate';
import { DEPLOY_USER, renderAccessUserData } from './cloudInit';
import { renderProfileScript, type MachineSetup } from './profile';

/** Arguments common to every machine component. */
export interface MachineArgsBase {
  fleet: FleetContext;
  region: string;
  /** Lowercase DNS label, unique within the fleet. Defaults to the component name. */
  id?: string;
  /** Defaults to `id`. */
  displayName?: string;
  /**
   * The machine's own FQDN. Defaults to `id`, a single-label hostname; set it when the machine
   * should know its fully qualified name. Workload hostnames are DNS aliases and never change it.
   */
  hostname?: string;
  enableIpv6?: boolean;
  /**
   * What the machine may send. Defaults to `DEFAULT_EGRESS` (DNS, NTP, HTTP, HTTPS, QUIC and ICMP, to anywhere); pass
   * `ALLOW_ALL_EGRESS` to lift the restriction. Node services that dial other ports need their rules added here.
   */
  egress?: FirewallRule[];
  /**
   * `HH:MM` (UTC) when the machine reboots after a security update that needs one, or false never to reboot. Defaults to
   * `04:00`. Stagger it across machines that serve the same clients.
   */
  automaticReboot?: string | false;
  /** Extra packages, files and commands, applied with the machine profile. */
  setup?: MachineSetup;
}

interface MachineIdentity {
  id: string;
  displayName: string;
  hostname: string;
  /** `<namePrefix>-<environment>-<id>`, truncated to the provider limit. */
  cloudName: string;
}

export function readMachineIdentity(name: string, args: MachineArgsBase, maxLength: number): MachineIdentity {
  const id = assertDnsLabel(args.id ?? name, 'Machine id');
  return {
    id,
    displayName: args.displayName ?? id,
    hostname: args.hostname === undefined ? id : readHostname(args.hostname, `Machine "${id}" hostname`),
    cloudName: truncateWithHash(resourceName(args.fleet.namePrefix, args.fleet.environment, id), maxLength)
  };
}

export function machineEgress(args: MachineArgsBase): readonly FirewallRule[] {
  return args.egress ?? DEFAULT_EGRESS;
}

/** User data for providers that take it: the deploy user and sshd on the fleet port. */
export function machineUserData(identity: MachineIdentity, args: MachineArgsBase): pulumi.Output<string> {
  return renderAccessUserData({
    hostname: identity.id,
    fqdn: identity.hostname,
    ssh: args.fleet.ssh,
    authorizedKey: args.fleet.publicKeyOpenSsh
  });
}

export function sshConnection(
  fleet: FleetContext,
  host: pulumi.Input<string>,
  user: string = DEPLOY_USER,
  port: number = fleet.ssh.port
): pulumi.Output<commandTypes.input.remote.ConnectionArgs> {
  return pulumi.output({ host, privateKey: fleet.privateKeyPem }).apply(({ host, privateKey }) => ({
    host,
    user,
    port,
    privateKey,
    // sshd only moves to the fleet port once its first boot restarts it, so keep dialling until then.
    perDialTimeout: 30,
    dialErrorLimit: 60
  }));
}

/** Completes when cloud-init has finished, connecting as the deploy user its user data created. */
export function waitForCloudInit(
  name: string,
  fleet: FleetContext,
  host: pulumi.Output<string>,
  parent: pulumi.Resource
): remote.Command {
  const command = 'sudo cloud-init status --wait --long';
  return new remote.Command(
    `${name}-cloud-init-ready`,
    { connection: sshConnection(fleet, host), create: command, update: command, triggers: [host, DEPLOY_USER] },
    { parent }
  );
}

export interface ApplyProfileArgs {
  identity: MachineIdentity;
  machine: MachineArgsBase;
  connection: pulumi.Output<commandTypes.input.remote.ConnectionArgs>;
  /** Give the machine a host firewall: for providers without a cloud firewall. */
  hostFirewall?: boolean;
  installation?: pulumi.Output<string>;
}

/** The machine profile as `<name>-profile`: applied once the deploy user can connect, and again whenever it changes. */
export function applyProfile(name: string, args: ApplyProfileArgs, opts: pulumi.CustomResourceOptions): remote.Command {
  const { identity, machine } = args;
  const script = renderProfileScript({
    hostname: identity.id,
    fqdn: identity.hostname,
    ssh: machine.fleet.ssh,
    authorizedKey: machine.fleet.publicKeyOpenSsh,
    automaticReboot: machine.automaticReboot ?? '04:00',
    hostFirewall: args.hostFirewall ? { egress: machineEgress(machine) } : undefined,
    setup: machine.setup
  }).apply(body => asRemoteScript(body, true));
  return new remote.Command(
    `${name}-profile`,
    {
      connection: args.connection,
      create: script,
      update: script,
      triggers: args.installation === undefined ? [] : [args.installation]
    },
    opts
  );
}
