import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { BinaryStore, defineBinary, reportsVersion, type Installed } from '@conservationtv/converge/binaries';
import { toYaml, type BuildDiagnostic } from '@conservationtv/mediamtx';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import type { AgentConfiguration } from '../config.ts';
import { mediamtxConfig, MEDIAMTX_METRICS_ADDRESS } from './mediamtx-config.ts';
import { MediamtxMetrics, type MediamtxMetricsStatus } from './mediamtx-metrics.ts';

const run = promisify(execFile);

export const mediamtxBinary = defineBinary({ name: 'mediamtx', checks: [reportsVersion(['--version'])] });
export const MediamtxSpecSchema = z.object({
  mediamtx: mediamtxBinary.schema,
  intervalMs: z.number().int().min(1000)
});
export type MediamtxSpec = z.output<typeof MediamtxSpecSchema>;

export interface MediamtxStatus {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid: number | null;
  version: string | null;
  installing: boolean;
  restarts: number;
  lastError: string | null;
  diagnostics: BuildDiagnostic[];
  metrics: MediamtxMetricsStatus;
}

const ProcessRecordSchema = z.object({
  pid: z.number().int().positive(),
  installId: z.string(),
  configHash: z.string()
});
type ProcessRecord = z.output<typeof ProcessRecordSchema>;
interface Current {
  installed: Installed;
  spec: MediamtxSpec;
}

/**
 * A vendored, detached MediaMTX. Agent shutdown leaves it serving; a new runtime adopts the recorded process.
 * Removing the converge key stops it and removes its files. A binary or config change restarts the process.
 */
export class MediamtxRuntime {
  readonly status$: BehaviorSubject<MediamtxStatus>;
  private readonly binaries: BinaryStore;
  private readonly metrics: MediamtxMetrics;
  private readonly configPath: string;
  private readonly recordPath: string;
  private readonly logPath: string;
  private tail: Promise<void> = Promise.resolve();
  private current: Current | undefined = undefined;
  private pid: number | undefined = undefined;
  private watching: ReturnType<typeof setTimeout> | undefined = undefined;
  private readonly lifetime = new AbortController();
  private failures = 0;
  private disposed = false;

  /** `directory` belongs exclusively to this runtime, and must persist across agent restarts. */
  constructor(
    config: AgentConfiguration,
    private readonly directory: string
  ) {
    this.binaries = new BinaryStore({ directory: join(directory, 'binaries') });
    this.configPath = join(directory, 'mediamtx.yml');
    this.recordPath = join(directory, 'process.json');
    this.logPath = join(directory, 'mediamtx.log');
    this.metrics = new MediamtxMetrics(config);
    this.status$ = new BehaviorSubject<MediamtxStatus>({
      state: 'stopped',
      pid: null,
      version: null,
      installing: false,
      restarts: 0,
      lastError: null,
      diagnostics: [],
      metrics: this.metrics.status$.getValue()
    });
    this.metrics.status$.subscribe(metrics => this.update({ metrics }));
  }

  execute(spec: MediamtxSpec, signal: AbortSignal): Promise<void> {
    return this.serially(async () => {
      this.update({ installing: true });
      const installed = await this.binaries
        .install(mediamtxBinary, spec.mediamtx, signal)
        .finally(() => this.update({ installing: false }));
      await this.serve(installed, signal);
      this.current = { installed, spec };
      this.failures = 0;
      this.watch();
      this.metrics.start(spec.intervalMs);
      await this.binaries.prune(installed, { spare: 1 });
    });
  }

  finalize(): Promise<void> {
    return this.serially(async () => {
      clearTimeout(this.watching);
      this.current = undefined;
      this.metrics.stop();
      await this.halt();
      await this.binaries.clear();
      await Promise.all([this.configPath, this.logPath].map(path => rm(path, { force: true })));
      this.update({ state: 'stopped', pid: null, version: null, lastError: null, diagnostics: [] });
    });
  }

  /** Only monitoring and shipping stop. MediaMTX stays up for the next agent to adopt. */
  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    clearTimeout(this.watching);
    this.metrics.dispose();
    this.status$.complete();
  }

  /** Adopt only an identical install and rendered config; otherwise switch after installation has succeeded. */
  private async serve(installed: Installed, signal: AbortSignal): Promise<void> {
    const activeSignal = AbortSignal.any([signal, this.lifetime.signal]);
    activeSignal.throwIfAborted();
    const rendered = await mediamtxConfig.render();
    this.update({ diagnostics: rendered.diagnostics });
    if (rendered.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      throw new Error('MediaMTX config builder reported errors');
    }
    const yaml = toYaml(rendered.config);
    const configHash = createHash('sha256').update(yaml).digest('hex');
    const record = await this.recorded();
    const pid = await this.find(record);
    if (pid !== undefined && record?.installId === installed.id && record.configHash === configHash) {
      this.pid = pid;
      await this.ready(pid, activeSignal);
    } else {
      await this.halt();
      activeSignal.throwIfAborted();
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.configPath}.tmp`;
      await writeFile(temporary, yaml);
      await rename(temporary, this.configPath);
      await this.start(installed, configHash, activeSignal);
    }
    activeSignal.throwIfAborted();
    this.update({ state: 'running', pid: this.pid ?? null, version: installed.version, lastError: null });
  }

  private async start(installed: Installed, configHash: string, signal: AbortSignal): Promise<void> {
    this.update({ state: 'starting', pid: null });
    const log = await open(this.logPath, 'a');
    const child = spawn(installed.path, [this.configPath], {
      cwd: this.directory,
      detached: true,
      stdio: ['ignore', log.fd, log.fd]
    });
    const started = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    try {
      await started;
      if (child.pid === undefined) throw new Error('MediaMTX did not start');
      this.pid = child.pid;
      const record: ProcessRecord = { pid: child.pid, installId: installed.id, configHash };
      await writeFile(`${this.recordPath}.tmp`, JSON.stringify(record));
      await rename(`${this.recordPath}.tmp`, this.recordPath);
      await this.ready(child.pid, signal);
    } catch (error) {
      await this.halt();
      this.update({ state: 'crashed', pid: null, lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      await log.close();
    }
  }

  /** The child must remain alive while its private metrics endpoint becomes available. */
  private async ready(pid: number, signal: AbortSignal): Promise<void> {
    const readySignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    while (true) {
      // Requests have their own short deadline so process exit and spec cancellation are checked promptly.
      readySignal.throwIfAborted();
      if (!alive(pid)) throw new Error(`MediaMTX exited before becoming ready; see ${this.logPath}`);
      const response = await fetch(`http://${MEDIAMTX_METRICS_ADDRESS}/metrics`, {
        signal: AbortSignal.any([readySignal, AbortSignal.timeout(1000)])
      }).catch(() => undefined);
      if (response !== undefined) {
        await response.body?.cancel();
        if (response.ok) {
          await delay(100, undefined, { signal: readySignal });
          if (alive(pid)) return;
        }
      }
      await delay(100, undefined, { signal: readySignal });
    }
  }

  /** A reused pid must still name MediaMTX, with this runtime's config when the OS supplies its command line. */
  private async find(record: ProcessRecord | undefined): Promise<number | undefined> {
    if (record === undefined || !alive(record.pid)) return undefined;
    if (process.platform === 'linux') return this.findLinux(record.pid);
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${record.pid}`, '/FO', 'CSV', '/NH'], { timeout: 2000 });
      return /^\s*"mediamtx\.exe",/i.test(stdout) ? record.pid : undefined;
    }
    const { stdout } = await run('ps', ['-p', String(record.pid), '-o', 'comm=', '-o', 'args='], { timeout: 2000 });
    return stdout.includes('/mediamtx ') && stdout.includes(this.configPath) ? record.pid : undefined;
  }

  /** Linux needs no external ps utility, including in the agent's scratch image. */
  private async findLinux(pid: number): Promise<number | undefined> {
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const [binary, ...args] = command.split('\0');
    return binary?.endsWith('/mediamtx') && args.includes(this.configPath) ? pid : undefined;
  }

  private async recorded(): Promise<ProcessRecord | undefined> {
    const text = await readFile(this.recordPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (text === undefined) return undefined;
    return ProcessRecordSchema.parse(JSON.parse(text));
  }

  private async halt(): Promise<void> {
    const pid = this.pid ?? (await this.find(await this.recorded()));
    this.pid = undefined;
    if (pid !== undefined && alive(pid)) await stopProcess(pid);
    await rm(this.recordPath, { force: true });
    this.update({ pid: null });
  }

  private watch(): void {
    clearTimeout(this.watching);
    if (this.disposed || this.current === undefined) return;
    const timeout = this.failures === 0 ? 1000 : Math.min(1000 * 2 ** (this.failures - 1), 30_000);
    this.watching = setTimeout(() => {
      void this.serially(() => this.revive()).finally(() => this.watch());
    }, timeout);
    this.watching.unref();
  }

  /** Restart a dead process with backoff; install or removal operations run in the same serial queue. */
  private async revive(): Promise<void> {
    const current = this.current;
    if (current === undefined || this.disposed || (this.pid !== undefined && alive(this.pid))) return;
    this.metrics.stop();
    this.update({ state: 'crashed', pid: null, restarts: this.status$.getValue().restarts + 1 });
    try {
      await this.serve(current.installed, AbortSignal.timeout(15_000));
      this.failures = 0;
      this.metrics.start(current.spec.intervalMs);
    } catch (error) {
      this.failures++;
      this.update({ state: 'crashed', lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private serially(task: () => Promise<void>): Promise<void> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private update(change: Partial<MediamtxStatus>): void {
    if (!this.disposed) this.status$.next({ ...this.status$.getValue(), ...change });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

// Give graceful shutdown a bounded window, then confirm SIGKILL has actually released the process.
async function stopProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
    await waitForExit(pid, 5000);
    if (alive(pid)) process.kill(pid, 'SIGKILL');
    await waitForExit(pid, 2000);
    if (alive(pid)) throw new Error(`MediaMTX process ${pid} did not stop`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await delay(50);
}
