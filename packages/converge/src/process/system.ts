import { execFile as execFileCallback } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';

// What the operating system says about a process, and about who listens on a port: from /proc on Linux, which needs
// no tools (the agent's image has none), and from `ps` and `lsof` on macOS. Other platforms know nothing, so a process
// is never adopted there and a port is never checked.

const execFile = promisify(execFileCallback);

/** A process as the operating system sees it. */
export interface ProcessInfo {
  pid: number;
  /** Its executable's name. */
  name: string;
  /** Its executable, as far as the system tells. */
  path: string;
  /**
   * When it started, in the system's own terms: opaque, but the same for as long as the process lives, so a pid reused
   * by another process is told apart by it.
   */
  startedAt: string;
}

/** Who listens on a TCP port: the processes found, and whether anything does, seen or not. */
export interface PortHolders {
  held: boolean;
  pids: number[];
}

/** The process at `pid`, or `undefined` if there is none, or the platform can't tell. */
export function processInfo(pid: number): Promise<ProcessInfo | undefined> {
  if (process.platform === 'linux') return linuxProcessInfo(pid);
  if (process.platform === 'darwin') return darwinProcessInfo(pid);
  return Promise.resolve(undefined);
}

/** Who listens on TCP `port`, on any address. Nobody, as far as an unsupported platform can tell. */
export function portHolders(port: number): Promise<PortHolders> {
  if (process.platform === 'linux') return linuxPortHolders(port);
  if (process.platform === 'darwin') return darwinPortHolders(port);
  return Promise.resolve({ held: false, pids: [] });
}

/** The port of an address such as `127.0.0.1:9997` or `:8554`. */
export function portOf(address: string): number {
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`No port in ${address}`);
  return port;
}

/** Where `/proc/<pid>/stat` keeps the start time, counting from its state, the first field after the name. */
const STAT_START_TIME = 19;

async function linuxProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return undefined;
  // The name is in parentheses and may hold spaces and parentheses of its own, so the fields follow the last `)`.
  const close = stat.lastIndexOf(')');
  const command = stat.slice(stat.indexOf('(') + 1, close);
  const startedAt = stat.slice(close + 2).split(' ')[STAT_START_TIME];
  if (startedAt === undefined) return undefined;
  // The executable, unless it is another user's; `(deleted)` follows it once its file is gone.
  const path = await readlink(`/proc/${pid}/exe`).catch(() => undefined);
  return { pid, name: path === undefined ? command : basename(path), path: path ?? command, startedAt };
}

/** How long `ps -o lstart` writes a start time, such as `Mon Oct 26 18:59:47 2026`, in the C locale. */
const LSTART_LENGTH = 24;

async function darwinProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  const env = { ...process.env, LC_ALL: 'C' };
  const listed = await execFile('ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)], { env }).catch(
    () => undefined
  );
  const line = listed?.stdout.trim();
  if (line === undefined || line === '') return undefined;
  const startedAt = line.slice(0, LSTART_LENGTH);
  const path = line.slice(LSTART_LENGTH).trim();
  return { pid, name: basename(path), path, startedAt };
}

/** The TCP state `/proc/net/tcp` writes for a listening socket. */
const TCP_LISTEN = '0A';

async function linuxPortHolders(port: number): Promise<PortHolders> {
  const inodes = await listeningSockets(port);
  if (inodes.size === 0) return { held: false, pids: [] };
  return { held: true, pids: await socketOwners(inodes) };
}

/** The inodes of the sockets listening on TCP `port`, over IPv4 and IPv6. */
async function listeningSockets(port: number): Promise<Set<string>> {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    // After a header, a socket a line: `sl local_address rem_address st … inode`, the port in hex after the address.
    // Kept when it listens on `port`; a table that can't be read lists none.
    const text = await readFile(table, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const inode = listeningInode(line, port);
      if (inode !== undefined) inodes.add(inode);
    }
  }
  return inodes;
}

/** The inode of the socket on a line of `/proc/net/tcp`, if it listens on `port`. */
function listeningInode(line: string, port: number): string | undefined {
  const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
  if (local === undefined || state !== TCP_LISTEN) return undefined;
  return Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16) === port ? inode : undefined;
}

/** The processes with one of the sockets `inodes` open: only those this user may look into are seen. */
async function socketOwners(inodes: Set<string>): Promise<number[]> {
  const sockets = new Set([...inodes].map(inode => `socket:[${inode}]`));
  const pids: number[] = [];
  for (const entry of await readdir('/proc').catch(() => [])) {
    const pid = Number(entry);
    if (Number.isInteger(pid) && (await holdsSocket(pid, sockets))) pids.push(pid);
  }
  return pids;
}

/** Whether `pid` has one of `sockets` open, as its descriptors' links name them. */
async function holdsSocket(pid: number, sockets: Set<string>): Promise<boolean> {
  for (const descriptor of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
    const target = await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => undefined);
    if (target !== undefined && sockets.has(target)) return true;
  }
  return false;
}

async function darwinPortHolders(port: number): Promise<PortHolders> {
  // `lsof` exits 1 when nothing matches, as when nobody listens.
  const listed = await execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']).catch(() => undefined);
  const pids = (listed?.stdout ?? '')
    .split('\n')
    .filter(line => line.startsWith('p'))
    .map(line => Number(line.slice(1)));
  return { held: pids.length > 0, pids: [...new Set(pids)] };
}
