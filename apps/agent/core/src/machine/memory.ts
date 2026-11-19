import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';

// How much memory the machine can give programs without swapping: what each OS itself says is available, counting
// the cache it would drop for them. Not the memory that is unused outright (`os.freemem()` on macOS), which an OS
// keeps low on purpose by filling it with cache: on a Mac that is well short of a hundredth of its memory, however
// little it is under pressure.
//
//   - Linux: `MemAvailable` in /proc/meminfo, the kernel's estimate of it.
//   - macOS: `kern.memorystatus_level`, the share of memory the kernel counts as free when it judges pressure, as
//     `memory_pressure` reports it.
//   - Windows: `os.freemem()`, which is already the available physical memory there.
//
// When an OS's own figure can't be read, `os.freemem()` stands in.

const run = promisify(execFile);

/** Bytes of memory the machine can give programs without swapping. */
export async function availableMemory(): Promise<number> {
  try {
    if (process.platform === 'linux') return await linuxAvailable();
    if (process.platform === 'darwin') return await macAvailable();
  } catch {
    // Fall through to what Node reports.
  }
  return os.freemem();
}

async function linuxAvailable(): Promise<number> {
  const meminfo = await readFile('/proc/meminfo', 'utf8');
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  if (match === null) throw new Error('/proc/meminfo has no MemAvailable');
  return Number(match[1]) * 1024;
}

async function macAvailable(): Promise<number> {
  const { stdout } = await run('sysctl', ['-n', 'kern.memorystatus_level'], { timeout: 2_000 });
  const level = Number(stdout.trim());
  if (!Number.isFinite(level) || level < 0 || level > 100)
    throw new Error(`kern.memorystatus_level is not a percentage: ${stdout}`);
  const total = os.totalmem();
  return Math.round((total * level) / 100);
}
