import { posix } from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import type { FirewallRule, SshAccess } from '../contracts';
import { shellQuote, writeFileLines } from '../shell';
import { DEPLOY_USER, RESTART_SSH, SSHD_CONFIG_PATH, sshdConfig } from './cloudInit';
import {
  HOST_FIREWALL_DIR,
  HOST_FIREWALL_PATH,
  HOST_FIREWALL_UNIT,
  hostFirewallUnit,
  renderHostFirewall
} from './hostFirewall';

export interface MachineSetupFile {
  /** Absolute. */
  path: string;
  content: pulumi.Input<string>;
  /** Defaults to `root:root`. */
  owner?: string;
  /** Defaults to `0644`. */
  permissions?: string;
}

/** Additions to the machine profile, applied after Docker, updates, sshd and the firewall. */
export interface MachineSetup {
  packages?: string[];
  files?: MachineSetupFile[];
  /** Run last, as root. */
  commands?: pulumi.Input<string>[];
}

export interface ProfileArgs {
  /** The machine id: the short hostname. */
  hostname: string;
  fqdn: string;
  ssh: SshAccess;
  authorizedKey: pulumi.Input<string>;
  /** `HH:MM` (UTC) when a reboot an update needs happens, or false never to reboot. */
  automaticReboot: string | false;
  /** A host firewall, for providers without a cloud firewall. */
  hostFirewall?: HostFirewallProfile;
  setup?: MachineSetup;
}

export interface HostFirewallProfile {
  /** What the machine may send; sources are destinations here. */
  egress: readonly FirewallRule[];
}

const REBOOT_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const FILE_MODE = /^0?[0-7]{3,4}$/;
const OWNER = /^[a-z_][a-z0-9_-]*(?::[a-z_][a-z0-9_-]*)?$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+:~-]+)?$/;

// Kernel settings that remove information leaks and network behaviour a relay never needs. IP forwarding stays as
// Docker sets it; reverse-path filtering stays Ubuntu's loose default, which a mesh route needs.
const SYSCTL_HARDENING =
  dedent`
  kernel.kptr_restrict = 2
  kernel.dmesg_restrict = 1
  kernel.unprivileged_bpf_disabled = 1
  net.core.bpf_jit_harden = 2
  kernel.kexec_load_disabled = 1
  dev.tty.ldisc_autoload = 0
  fs.protected_fifos = 2
  fs.protected_regular = 2
  fs.suid_dumpable = 0
  net.ipv4.conf.all.accept_redirects = 0
  net.ipv4.conf.default.accept_redirects = 0
  net.ipv6.conf.all.accept_redirects = 0
  net.ipv6.conf.default.accept_redirects = 0
  net.ipv4.conf.all.secure_redirects = 0
  net.ipv4.conf.default.secure_redirects = 0
  net.ipv4.conf.all.send_redirects = 0
  net.ipv4.conf.default.send_redirects = 0
  net.ipv4.conf.all.accept_source_route = 0
  net.ipv4.conf.default.accept_source_route = 0
  net.ipv6.conf.all.accept_source_route = 0
  net.ipv6.conf.default.accept_source_route = 0
  net.ipv4.tcp_syncookies = 1
` + '\n';

// Sorts after Ubuntu's 20auto-upgrades and 50unattended-upgrades, so these values win.
function unattendedUpgrades(reboot: string | false): string {
  return (
    dedent`
    APT::Periodic::Update-Package-Lists "1";
    APT::Periodic::Unattended-Upgrade "1";
    APT::Periodic::AutocleanInterval "7";
    Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
    Unattended-Upgrade::Remove-Unused-Dependencies "true";
    Unattended-Upgrade::Automatic-Reboot "${reboot === false ? 'false' : 'true'}";
    ${reboot === false ? '' : `Unattended-Upgrade::Automatic-Reboot-Time "${reboot}";`}
  `.trim() + '\n'
  );
}

// cloud-init would restore the provider's hostname and /etc/hosts on every boot.
const CLOUD_INIT_HOSTNAME = 'preserve_hostname: true\nmanage_etc_hosts: false\n';

const DOCKER = dedent`
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ARCH="$(dpkg --print-architecture)"
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" > /etc/apt/sources.list.d/docker.list
  $APT update
  $APT install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
`;

interface ProfileFile {
  path: string;
  content: string;
  owner: string;
  mode: string;
}

/**
 * The profile every fleet machine gets, as one idempotent root script: run once the machine is reachable as the deploy
 * user, and again whenever it changes. It sets the hostname for good, re-asserts the deploy user and sshd, installs
 * Docker and automatic security updates (rebooting at `automaticReboot` when one needs it), hardens kernel settings,
 * locks root's password, and installs the host firewall when the machine has one.
 */
export function renderProfileScript(args: ProfileArgs): pulumi.Output<string> {
  assertProfileArgs(args);
  const setup = args.setup ?? {};
  const setupFiles = setup.files ?? [];
  return pulumi
    .all([
      pulumi.output(args.authorizedKey),
      pulumi.all(setupFiles.map(file => file.content)),
      pulumi.all(setup.commands ?? [])
    ])
    .apply(([key, contents, commands]) => {
      const files: ProfileFile[] = [
        {
          path: '/etc/cloud/cloud.cfg.d/90-fleet-hostname.cfg',
          content: CLOUD_INIT_HOSTNAME,
          owner: 'root:root',
          mode: '0644'
        },
        { path: SSHD_CONFIG_PATH, content: sshdConfig(args.ssh.port), owner: 'root:root', mode: '0644' },
        { path: '/etc/sysctl.d/50-fleet-hardening.conf', content: SYSCTL_HARDENING, owner: 'root:root', mode: '0644' },
        {
          path: '/etc/apt/apt.conf.d/52fleet-unattended-upgrades',
          content: unattendedUpgrades(args.automaticReboot),
          owner: 'root:root',
          mode: '0644'
        },
        ...(args.hostFirewall
          ? [
              {
                path: HOST_FIREWALL_PATH,
                content: renderHostFirewall(args.ssh, args.hostFirewall.egress),
                owner: 'root:root',
                mode: '0600'
              },
              {
                path: `/etc/systemd/system/${HOST_FIREWALL_UNIT}`,
                content: hostFirewallUnit(),
                owner: 'root:root',
                mode: '0644'
              }
            ]
          : []),
        ...setupFiles.map((file, index) => ({
          path: file.path,
          content: contents[index],
          owner: file.owner ?? 'root:root',
          mode: file.permissions ?? '0644'
        }))
      ];
      const packages = [
        'ca-certificates',
        'curl',
        'gnupg',
        'unattended-upgrades',
        ...(args.hostFirewall ? ['nftables'] : []),
        ...(setup.packages ?? [])
      ];
      return [
        'set -eu',
        'export DEBIAN_FRONTEND=noninteractive',
        // Apt's daily timers may hold the lock just after boot.
        'APT="apt-get -o DPkg::Lock::Timeout=600 -y -q"',
        hostnameLines(args.hostname, args.fqdn),
        deployUserLines(key),
        ...files.flatMap(file => [
          `install -m 0755 -d ${shellQuote(posix.dirname(file.path))}`,
          ...writeFileLines(file.path, file.content, file.mode),
          `chown ${shellQuote(file.owner)} ${shellQuote(file.path)}`
        ]),
        '$APT update',
        `$APT install ${packages.map(shellQuote).join(' ')}`,
        DOCKER,
        'systemctl enable --now unattended-upgrades',
        'sysctl --system >/dev/null',
        RESTART_SSH,
        'passwd -l root >/dev/null',
        ...(args.hostFirewall ? [hostFirewallLines()] : []),
        ...commands
      ].join('\n');
    });
}

function hostnameLines(hostname: string, fqdn: string): string {
  const hosts = `127.0.1.1 ${fqdn === hostname ? hostname : `${fqdn} ${hostname}`}`;
  return dedent`
    hostnamectl set-hostname ${shellQuote(fqdn)}
    if grep -q '^127\\.0\\.1\\.1[[:space:]]' /etc/hosts; then
      sed -i ${shellQuote(`s/^127\\.0\\.1\\.1[[:space:]].*/${hosts}/`)} /etc/hosts
    else
      echo ${shellQuote(hosts)} >> /etc/hosts
    fi
  `;
}

/**
 * Creates the deploy user if missing and (re)writes its key and sudo rule. The sudoers file is checked before it replaces
 * anything: a broken one would lock sudo for every user.
 */
export function deployUserLines(key: string): string {
  const home = `/home/${DEPLOY_USER}`;
  return [
    `id -u ${DEPLOY_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${DEPLOY_USER}`,
    `install -d -m 0700 -o ${DEPLOY_USER} -g ${DEPLOY_USER} ${home}/.ssh`,
    ...writeFileLines(`${home}/.ssh/authorized_keys`, `${key.trim()}\n`, '0600'),
    `chown ${DEPLOY_USER}:${DEPLOY_USER} ${home}/.ssh/authorized_keys`,
    ...writeFileLines('/etc/sudoers.d/.90-fleet.new', `${DEPLOY_USER} ALL=(ALL) NOPASSWD:ALL\n`, '0440'),
    'visudo -cqf /etc/sudoers.d/.90-fleet.new',
    'mv /etc/sudoers.d/.90-fleet.new /etc/sudoers.d/90-fleet'
  ].join('\n');
}

function hostFirewallLines(): string {
  return dedent`
    install -m 0700 -d ${HOST_FIREWALL_DIR}
    nft -c -f ${HOST_FIREWALL_PATH}
    systemctl daemon-reload
    systemctl enable ${HOST_FIREWALL_UNIT}
    systemctl restart ${HOST_FIREWALL_UNIT}
  `;
}

// Plan-time checks, so a bad value fails the program rather than a script on the machine.
function assertProfileArgs(args: ProfileArgs): void {
  if (args.automaticReboot !== false && !REBOOT_TIME.test(args.automaticReboot)) {
    throw new Error(`automaticReboot must be HH:MM (24-hour, UTC) or false, got "${args.automaticReboot}".`);
  }
  for (const name of args.setup?.packages ?? []) {
    if (!PACKAGE.test(name)) throw new Error(`Setup package "${name}" is not a Debian package name.`);
  }
  for (const file of args.setup?.files ?? []) assertSetupFile(file);
}

// A setup file needs an absolute path; its permissions and owner, when given, must be an octal mode and a user[:group].
function assertSetupFile(file: MachineSetupFile): void {
  if (!posix.isAbsolute(file.path)) throw new Error(`Setup file path "${file.path}" must be absolute.`);
  if (file.permissions !== undefined && !FILE_MODE.test(file.permissions)) {
    throw new Error(`Setup file "${file.path}" has invalid permissions ${file.permissions}.`);
  }
  if (file.owner !== undefined && !OWNER.test(file.owner)) {
    throw new Error(`Setup file "${file.path}" has invalid owner ${file.owner}.`);
  }
}
