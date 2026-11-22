import { readFile, readdir, readlink } from 'node:fs/promises';
import { basename } from 'node:path';

// What converge needs to know about other processes on Linux, read from /proc rather than by running `ps`, which a
// minimal container doesn't have.

/**
 * The name of the process at `pid`: its executable's file name, or the kernel's (possibly cut short) name for it when
 * the executable can't be read. Undefined when `pid` is not a process but one of a process's threads, as a recorded
 * pid often is in a fresh container's pid namespace, or when there is no such process.
 */
export async function processName(pid: number): Promise<string | undefined> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => undefined);
  if (status === undefined) return undefined;
  if (field(status, 'Tgid') !== String(pid)) return undefined;
  const executable = await readlink(`/proc/${pid}/exe`).catch(() => undefined);
  // An executable replaced on disk reads as "<path> (deleted)".
  if (executable !== undefined) return basename(executable.replace(/ \(deleted\)$/, ''));
  return field(status, 'Name');
}

/** Every process descended from `pid`, children before their own children. */
export async function descendants(pid: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  const entries = await readdir('/proc').catch(() => []);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const parent = await parentOf(Number(entry));
    if (parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const next = children.get(queue.shift()!) ?? [];
    found.push(...next);
    queue.push(...next);
  }
  return found;
}

async function parentOf(pid: number): Promise<number | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return undefined;
  // "pid (comm) state ppid …": comm may hold spaces and parentheses, so read on from the last one.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const parent = Number(rest[1]);
  return Number.isInteger(parent) ? parent : undefined;
}

function field(status: string, name: string): string | undefined {
  const match = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status);
  return match?.[1]?.trim();
}
