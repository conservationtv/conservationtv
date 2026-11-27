import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import * as yaml from 'yaml';
import type { SshAccess } from '../contracts';

/** The user every deployment connects as. Root logins are refused; it runs remote scripts through sudo. */
export const DEPLOY_USER = 'fleet';

// sshd keeps the first value it reads for each keyword and reads drop-ins in lexical order, so this must sort
// before the image's own drop-ins (e.g. 50-cloud-init.conf) for key-only auth to take effect.
export const SSHD_CONFIG_PATH = '/etc/ssh/sshd_config.d/10-fleet.conf';

/** Key-only SSH for the deploy user alone, on the fleet's port. Local forwarding stays on for private endpoints. */
export function sshdConfig(port: number): string {
  return (
    dedent`
    Port ${port}
    PermitRootLogin no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthenticationMethods publickey
    AllowUsers ${DEPLOY_USER}
    MaxAuthTries 3
    LoginGraceTime 20
    X11Forwarding no
    AllowAgentForwarding no
  ` + '\n'
  );
}

/**
 * Applies a changed sshd port. Ubuntu 24.04 starts sshd from `ssh.socket`, whose port comes from sshd_config through a
 * generator, so the socket needs a daemon-reload and restart; images without socket activation just restart sshd.
 * Open sessions survive both. `sshd -t` needs the privilege separation directory, which a socket-activated sshd only
 * creates once it first runs.
 */
export const RESTART_SSH = dedent`
  install -d -m 0755 /run/sshd
  sshd -t
  systemctl daemon-reload
  if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then systemctl restart ssh.socket; fi
  systemctl restart ssh || systemctl restart sshd
`;

export interface AccessUserDataArgs {
  hostname: string;
  fqdn: string;
  ssh: SshAccess;
  authorizedKey: pulumi.Input<string>;
}

/**
 * The machine's `#cloud-config`: only what reaching it needs. The deploy user with the fleet key, sshd on the fleet port,
 * and the hostname. Everything else is the machine profile, applied over SSH, so changing it never replaces a machine.
 */
export function renderAccessUserData(args: AccessUserDataArgs): pulumi.Output<string> {
  return pulumi
    .output(args.authorizedKey)
    .apply(key => `#cloud-config\n${renderAccessYaml({ ...args, authorizedKey: key })}`);
}

/** `AccessUserDataArgs` with the key resolved. */
export interface AccessYamlArgs extends Omit<AccessUserDataArgs, 'authorizedKey'> {
  authorizedKey: string;
}

export function renderAccessYaml(args: AccessYamlArgs): string {
  return yaml.stringify({
    hostname: args.hostname,
    preserve_hostname: false,
    fqdn: args.fqdn,
    prefer_fqdn_over_hostname: true,
    manage_etc_hosts: true,
    disable_root: true,
    ssh_pwauth: false,
    users: [
      {
        name: DEPLOY_USER,
        gecos: 'Fleet deployment',
        shell: '/bin/bash',
        lock_passwd: true,
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
        ssh_authorized_keys: [args.authorizedKey.trim()]
      }
    ],
    bootcmd: ['mkdir -p /etc/ssh/sshd_config.d'],
    write_files: [
      { path: SSHD_CONFIG_PATH, owner: 'root:root', permissions: '0644', content: sshdConfig(args.ssh.port) }
    ],
    runcmd: [`set -eu\n${RESTART_SSH}`]
  });
}
