import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import * as yaml from 'yaml';
import type { SshAccess } from '../contracts';

// sshd keeps the first value it reads for each keyword and reads drop-ins in lexical order, so this must sort
// before the image's own drop-ins (e.g. 50-cloud-init.conf) for key-only auth to take effect.
const SSHD_CONFIG_PATH = '/etc/ssh/sshd_config.d/10-fleet.conf';

export interface CloudInitFile {
  path: string;
  content: pulumi.Input<string>;
  /** Defaults to `root:root`. */
  owner?: string;
  /** Defaults to `0644`. */
  permissions?: string;
}

interface RenderedCloudInitFile extends Omit<CloudInitFile, 'content'> {
  content: string;
}

/** Additions to the base profile (Docker, sshd on the fleet port with key-only auth, root's authorized_keys). */
export interface MachineCloudInit {
  packages?: string[];
  files?: CloudInitFile[];
  /** Run after Docker is installed and sshd is restarted. */
  commands?: pulumi.Input<string>[];
}

interface CloudInitProfile {
  hostname: string;
  fqdn: string;
  ssh: SshAccess;
  sshAuthorizedKeys: string[];
  extraPackages?: string[];
  extraWriteFiles?: RenderedCloudInitFile[];
  extraRunCmds?: string[];
}

interface CloudInitArgs extends MachineCloudInit {
  hostname: string;
  fqdn: string;
  ssh: SshAccess;
  sshAuthorizedKeys: pulumi.Input<string>[];
}

/** The machine's `#cloud-config` user data. */
export function renderCloudInit(args: CloudInitArgs): pulumi.Output<string> {
  const files = args.files ?? [];
  for (const file of files) {
    if (!file.path.startsWith('/')) throw new Error(`Cloud-init file path "${file.path}" must be absolute.`);
  }
  return pulumi
    .all({
      keys: pulumi.all(args.sshAuthorizedKeys),
      fileContents: pulumi.all(files.map(file => file.content)),
      commands: pulumi.all(args.commands ?? [])
    })
    .apply(
      ({ keys, fileContents, commands }) =>
        `#cloud-config\n${renderCloudInitYaml({
          hostname: args.hostname,
          fqdn: args.fqdn,
          ssh: args.ssh,
          sshAuthorizedKeys: keys,
          extraPackages: args.packages,
          extraWriteFiles: files.map((file, index) => ({ ...file, content: fileContents[index] })),
          extraRunCmds: commands
        })}`
    );
}

export function renderCloudInitYaml(profile: CloudInitProfile): string {
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
    packages: profile.extraPackages ?? [],
    hostname: profile.hostname,
    preserve_hostname: false,
    fqdn: profile.fqdn,
    prefer_fqdn_over_hostname: true,
    manage_etc_hosts: true,
    bootcmd: ['mkdir -p /root/.ssh /etc/ssh/sshd_config.d'],
    write_files: [
      {
        path: SSHD_CONFIG_PATH,
        owner: 'root:root',
        permissions: '0644',
        content: dedent`
          Port ${profile.ssh.port}
          PermitRootLogin prohibit-password
          PasswordAuthentication no
          KbdInteractiveAuthentication no
        `
      },
      {
        path: '/root/.ssh/authorized_keys',
        owner: 'root:root',
        permissions: '0600',
        content: `${profile.sshAuthorizedKeys.join('\n').trim()}\n`
      },
      ...(profile.extraWriteFiles ?? []).map(file => ({
        path: file.path,
        owner: file.owner ?? 'root:root',
        permissions: file.permissions ?? '0644',
        content: file.content
      }))
    ],
    runcmd: [
      dockerScript,
      dedent`
        set -eu
        chmod 0700 /root/.ssh
        systemctl restart ssh || systemctl restart sshd
      `,
      ...(profile.extraRunCmds ?? [])
    ]
  });
}
