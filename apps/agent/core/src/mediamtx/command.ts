/**
 * A command for MediaMTX to run (`runOnInit`, `runOnDemand`, and the like), from its program and arguments. MediaMTX
 * splits a command as a POSIX shell would, on every platform, so each is single-quoted: a path with a space in it, such
 * as the desktop app's data under `Application Support`, stays one argument.
 */
export function mediamtxCommand(...argv: string[]): string {
  return argv.map(quoted).join(' ');
}

function quoted(argument: string): string {
  if (argument.includes("'")) throw new Error(`Cannot quote ${argument} for MediaMTX`);
  return `'${argument}'`;
}
