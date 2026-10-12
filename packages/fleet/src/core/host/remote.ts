import { remote, types as commandTypes } from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import type { SshAccessConfig } from '../config';
import { shellQuote } from './systemd';

export interface RemoteHostArgs {
  host: pulumi.Input<string>;
  ssh: SshAccessConfig;
  sshPrivateKeyPem: pulumi.Input<string>;
  cloudInitSshUser?: string;
  deploymentSshUser?: string;
}

export interface RemoteHost {
  connection: pulumi.Output<commandTypes.input.remote.ConnectionArgs>;
  ready: remote.Command;
  needsSudo: boolean;
}

export interface RemoteFileSpec {
  path: string;
  content: pulumi.Input<string>;
  permissions: string;
}

export interface RenderedRemoteFile {
  path: string;
  content: string;
  permissions: string;
}

export interface RemoteFilePathSpec {
  path: string;
  permissions: string;
}

// Wait for cloud-init with its SSH user, then expose the deployment connection and whether it needs sudo.
export function connectToRemoteHost(
  name: string,
  args: RemoteHostArgs,
  opts?: pulumi.ComponentResourceOptions
): RemoteHost {
  const cloudInitSshUser = args.cloudInitSshUser ?? 'root';
  const deploymentSshUser = args.deploymentSshUser ?? 'root';
  const connection = sshConnection(args, deploymentSshUser);
  const cloudInitConnection =
    cloudInitSshUser === deploymentSshUser ? connection : sshConnection(args, cloudInitSshUser);
  const command =
    cloudInitSshUser === 'root' ? 'cloud-init status --wait --long' : 'sudo cloud-init status --wait --long';
  const ready = new remote.Command(
    `${name}-wait-cloud-init`,
    {
      connection: cloudInitConnection,
      create: command,
      update: command,
      triggers: [args.host, cloudInitSshUser]
    },
    opts
  );
  return { connection, ready, needsSudo: deploymentSshUser !== 'root' };
}

function sshConnection(args: RemoteHostArgs, user: string): pulumi.Output<commandTypes.input.remote.ConnectionArgs> {
  return pulumi.output({ host: args.host, privateKey: args.sshPrivateKeyPem }).apply(({ host, privateKey }) => ({
    host,
    user,
    port: args.ssh.port,
    privateKey,
    perDialTimeout: 30,
    dialErrorLimit: 60
  }));
}

export function renderRemoteFileManifest(files: readonly RenderedRemoteFile[]): string {
  const scripts = files.map(file => {
    validateRemoteFile(file);
    const encoded = Buffer.from(file.content, 'utf8').toString('base64');
    return dedent`
      install -m 0755 -d ${shellQuote(parentDir(file.path))}
      base64 -d > ${shellQuote(file.path)} <<'__FLEET_FILE__'
      ${encoded}
      __FLEET_FILE__
      chmod ${file.permissions} ${shellQuote(file.path)}
    `;
  });
  return `set -eu\n${scripts.join('\n')}`;
}

export function writeRemoteFileManifest(
  name: string,
  host: RemoteHost,
  files: readonly RemoteFileSpec[],
  opts?: pulumi.ComponentResourceOptions
): remote.Command {
  const script = pulumi
    .all(files.map(file => pulumi.output(file.content)))
    .apply(contents =>
      asRemoteScript(
        renderRemoteFileManifest(files.map((file, index) => ({ ...file, content: contents[index] }))),
        host.needsSudo
      )
    );
  return new remote.Command(
    name,
    {
      connection: host.connection,
      create: script,
      update: script,
      triggers: files.map(file => file.content)
    },
    pulumi.mergeOptions(opts ?? {}, { dependsOn: [host.ready] })
  );
}

export function writeRemoteFile(
  name: string,
  host: RemoteHost,
  path: string,
  content: pulumi.Input<string>,
  permissions: string,
  opts?: pulumi.ComponentResourceOptions
): remote.Command {
  return writeRemoteFileManifest(name, host, [{ path, content, permissions }], opts);
}

export function asRemoteScript(script: string, needsSudo: boolean): string {
  return needsSudo ? `sudo /bin/sh -s <<'__FLEET_SUDO__'\n${script.trim()}\n__FLEET_SUDO__\n` : script;
}

function validateRemoteFile(file: RemoteFilePathSpec): void {
  if (!file.path.startsWith('/')) throw new Error(`Remote file path must be absolute: ${file.path}`);
  if (!/^0?[0-7]{3}$/.test(file.permissions)) throw new Error(`Invalid remote file permissions: ${file.permissions}`);
}

function parentDir(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
