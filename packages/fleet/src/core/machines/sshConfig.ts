import * as pulumi from '@pulumi/pulumi';
import type { Machine } from '../contracts';

export interface SshConfigOptions {
  /** Aliases are `<aliasPrefix>-<machine id>`, or the bare id when omitted. */
  aliasPrefix?: string;
  /** Defaults to `./fleet-ssh.key`. */
  identityFile?: string;
}

/** An OpenSSH config with one `Host` block per machine, using each machine's deployment connection. */
export function renderSshConfig(machines: readonly Machine[], options: SshConfigOptions = {}): pulumi.Output<string> {
  const identityFile = options.identityFile ?? './fleet-ssh.key';
  const aliases = machines.map(machine => (options.aliasPrefix ? `${options.aliasPrefix}-${machine.id}` : machine.id));
  const duplicate = aliases.find((alias, index) => aliases.indexOf(alias) !== index);
  if (duplicate) throw new Error(`SSH config alias "${duplicate}" is used by more than one machine.`);

  // The connection is secret because it carries the private key; only non-secret fields are kept.
  const hosts = machines.map(machine =>
    pulumi.unsecret(
      pulumi.output(machine.connection).apply(({ host, port, user }) => ({ host, port: port ?? 22, user }))
    )
  );
  return pulumi
    .all(hosts)
    .apply(
      resolved =>
        `${resolved
          .map(({ host, port, user }, index) =>
            [
              `Host ${aliases[index]}`,
              `  HostName ${host}`,
              `  Port ${port}`,
              ...(user ? [`  User ${user}`] : []),
              `  IdentityFile ${identityFile}`
            ].join('\n')
          )
          .join('\n\n')}\n`
    );
}
