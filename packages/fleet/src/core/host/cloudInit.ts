import * as cloudinit from '@pulumi/cloudinit';
import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import * as yaml from 'yaml';
import type { SshAccessConfig } from '../config';

export interface CloudInitWriteFile {
  path: string;
  content: pulumi.Input<string>;
  owner?: string;
  permissions?: string;
}

export interface CloudInitProfileArgs {
  hostname: string;
  fqdn: string;
  ssh: SshAccessConfig;
  sshAuthorizedKeys: pulumi.Input<string>[];
  sshdConfigName?: string;
  installDocker?: boolean;
  extraPackages?: string[];
  extraWriteFiles?: CloudInitWriteFile[];
  extraRunCmds?: pulumi.Input<string>[];
}
export interface ResolvedCloudInitWriteFile extends Omit<CloudInitWriteFile, 'content'> {
  content: string;
}

export interface ResolvedCloudInitProfileArgs extends Omit<
  CloudInitProfileArgs,
  'sshAuthorizedKeys' | 'extraWriteFiles' | 'extraRunCmds'
> {
  sshAuthorizedKeys: string[];
  extraWriteFiles?: ResolvedCloudInitWriteFile[];
  extraRunCmds?: string[];
}

// Validate the SSH config filename and resolve keys, optional files, and commands before rendering cloud-init.
export function renderCloudInitProfile(
  name: string,
  args: CloudInitProfileArgs,
  opts?: pulumi.ComponentResourceOptions
): pulumi.Output<string> {
  const sshdConfigName = args.sshdConfigName ?? '99-vps-fleet.conf';
  if (!/^[a-zA-Z0-9_.-]+$/.test(sshdConfigName)) throw new Error('sshdConfigName contains invalid characters.');

  const content = pulumi
    .all([
      ...args.sshAuthorizedKeys.map(value => pulumi.output(value)),
      ...(args.extraWriteFiles ?? []).map(file => pulumi.output(file.content)),
      ...(args.extraRunCmds ?? []).map(command => pulumi.output(command))
    ])
    .apply(resolved => {
      let cursor = 0;
      const keys = resolved.slice(cursor, (cursor += args.sshAuthorizedKeys.length));
      const extraFiles = (args.extraWriteFiles ?? []).map(file => ({ ...file, content: resolved[cursor++] }));
      const extraCommands = resolved.slice(cursor);
      return renderCloudInitYaml({
        ...args,
        sshAuthorizedKeys: keys,
        extraWriteFiles: extraFiles,
        extraRunCmds: extraCommands
      });
    });

  return new cloudinit.Config(
    name,
    {
      gzip: false,
      base64Encode: false,
      parts: [{ contentType: 'text/cloud-config', content: pulumi.interpolate`#cloud-config\n${content}` }]
    },
    opts
  ).rendered;
}

// Render SSH access settings with optional packages, files, and commands, installing Docker unless disabled.
export function renderCloudInitYaml(args: ResolvedCloudInitProfileArgs): string {
  const sshdConfigName = args.sshdConfigName ?? '99-vps-fleet.conf';
  if (!/^[a-zA-Z0-9_.-]+$/.test(sshdConfigName)) throw new Error('sshdConfigName contains invalid characters.');
  const dockerScript = dedent`
    set -eu
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    ARCH="$(dpkg --print-architecture)"
    CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
  `;

  return yaml.stringify({
    package_update: true,
    packages: args.extraPackages ?? [],
    hostname: args.hostname,
    preserve_hostname: false,
    fqdn: args.fqdn,
    prefer_fqdn_over_hostname: true,
    manage_etc_hosts: true,
    bootcmd: ['mkdir -p /root/.ssh /etc/ssh/sshd_config.d'],
    write_files: [
      {
        path: `/etc/ssh/sshd_config.d/${sshdConfigName}`,
        owner: 'root:root',
        permissions: '0644',
        content: dedent`
          Port ${args.ssh.port}
          PermitRootLogin prohibit-password
          PasswordAuthentication no
          KbdInteractiveAuthentication no
        `
      },
      {
        path: '/root/.ssh/authorized_keys',
        owner: 'root:root',
        permissions: '0600',
        content: `${args.sshAuthorizedKeys.join('\n').trim()}\n`
      },
      ...(args.extraWriteFiles ?? []).map(file => ({
        path: file.path,
        owner: file.owner ?? 'root:root',
        permissions: file.permissions ?? '0644',
        content: file.content
      }))
    ],
    runcmd: [
      ...(args.installDocker === false ? [] : [dockerScript]),
      dedent`
        set -eu
        chmod 0700 /root/.ssh
        systemctl restart ssh || systemctl restart sshd
      `,
      ...(args.extraRunCmds ?? [])
    ]
  });
}
