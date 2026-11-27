/** Quote a value as a single POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Run `script` as root: through `sudo` when the connection's user is not root, otherwise as given. */
export function asRemoteScript(script: string, sudo: boolean): string {
  return sudo ? `sudo /bin/sh -s <<'__FLEET_SUDO__'\n${script.trim()}\n__FLEET_SUDO__\n` : script;
}

/** Shell lines writing `content` to `path` with `mode`, through base64 so any content survives quoting. */
export function writeFileLines(path: string, content: string, mode: string): string[] {
  return [
    `base64 -d > ${shellQuote(path)} <<'__FLEET_FILE__'`,
    Buffer.from(content, 'utf8').toString('base64'),
    '__FLEET_FILE__',
    `chmod ${mode} ${shellQuote(path)}`
  ];
}
