import { remote, type types as commandTypes } from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import type { FleetContext } from '../contracts';
import { resourceName, truncateWithHash } from '../naming';
import { assertDnsLabel, readHostname } from '../validate';
import { renderCloudInit, type MachineCloudInit } from './cloudInit';

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
  cloudInit?: MachineCloudInit;
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

export function machineUserData(identity: MachineIdentity, args: MachineArgsBase): pulumi.Output<string> {
  return renderCloudInit({
    ...args.cloudInit,
    hostname: identity.id,
    fqdn: identity.hostname,
    ssh: args.fleet.ssh,
    sshAuthorizedKeys: [args.fleet.publicKeyOpenSsh]
  });
}

export function sshConnection(
  fleet: FleetContext,
  host: pulumi.Input<string>,
  user: string
): pulumi.Output<commandTypes.input.remote.ConnectionArgs> {
  return pulumi.output({ host, privateKey: fleet.privateKeyPem }).apply(({ host, privateKey }) => ({
    host,
    user,
    port: fleet.ssh.port,
    privateKey,
    // sshd only moves to the fleet port once cloud-init restarts it, so keep dialling until then.
    perDialTimeout: 30,
    dialErrorLimit: 60
  }));
}

/** Completes when cloud-init has finished, connecting as the image's cloud-init user. */
export function waitForCloudInit(
  name: string,
  fleet: FleetContext,
  host: pulumi.Output<string>,
  user: string,
  parent: pulumi.Resource
): remote.Command {
  const command = `${user === 'root' ? '' : 'sudo '}cloud-init status --wait --long`;
  return new remote.Command(
    `${name}-cloud-init-ready`,
    { connection: sshConnection(fleet, host, user), create: command, update: command, triggers: [host, user] },
    { parent }
  );
}
