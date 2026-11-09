import { connect as dial } from 'node:net';
import { join } from 'node:path';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { AttachedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import type { Client, DeviceIdentity } from '@conservationtv/studio-sdk';
import type { Target, TargetPhase } from '@strangecyan/vignette';
import { obsTarget } from '@strangecyan/vignette/obs';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import { type MoqManifest, moqBinary } from '../mediamtx/binaries/moq.ts';
import { type ObsManifest, obsBinary } from './binaries/obs.ts';
import { ctvStreamObs } from './ctv-stream.ts';
import { obsLaunch, websocketPassword, writeObsSettings } from './settings.ts';
import { showStream } from './show-stream.ts';

/** The show to send out: the one the agent is the output of, followed at `url` (src/configuration in the studio API). */
export const ObsSpecSchema = z.object({
  show: z.object({ id: z.string(), url: z.url() })
});
export type ObsSpec = z.output<typeof ObsSpecSchema>;

/** The room the runtime is given, and the releases it runs. */
export interface ObsRuntimeOptions {
  /** A directory of its own: binaries under `binaries/`, OBS's log and pidfile, its macOS home, and relays. */
  directory: string;
  /** The OBS release to run. */
  binary: ObsManifest;
  /** The moq CLI release the streams are relayed by. */
  moq: MoqManifest;
  /** The port obs-websocket serves on, on this machine. */
  websocketPort: number;
  /** The studio API, as the agent's device, for read sessions. */
  studio: Client;
  /** The agent's identity, which following the show is signed as. */
  identity: DeviceIdentity;
}

export interface ObsStatus extends ProcessStatus {
  /** The version of OBS running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
  /** The show being sent out, and how far OBS has caught up with it. */
  show: string | null;
  phase: TargetPhase | null;
}

const STOPPED: ObsStatus = { ...PROCESS_STOPPED, version: null, installing: false, show: null, phase: null };

/** OBS's executable name, as `ps` reports it. */
const PROCESS_NAME = process.platform === 'win32' ? 'obs64' : 'OBS';

/** A first start scans plugins, and macOS checks a new app: OBS may take a while to answer. */
const READY_TIMEOUT_MS = 60_000;

/** The target sending one show out, and how to stop it following. */
interface Following {
  show: ObsSpec['show'];
  target: Target;
  stop: () => void;
  watching: () => void;
}

/**
 * The `obs` key, fulfilled by an OBS of the agent's own: installed by the runtime, started with a configuration it
 * writes (obs-websocket on its port, with its password), and lived and died with the agent. Vignette's OBS target
 * converges it to the show the spec names, following the show's stream; the `ctv-stream` plugin plays the streams the
 * show places. OBS runs on Windows and macOS only (binaries/obs.ts).
 *
 * The target touches only what it made (`vignette/<show>/…` scenes and inputs), so anything an operator adds in OBS
 * stays. Stopping OBS is something it takes for a crash, so each launch clears that first (settings.ts).
 */
export class ObsRuntime {
  readonly status$ = new BehaviorSubject<ObsStatus>(STOPPED);
  private readonly binaries: BinaryStore;
  private readonly process: AttachedProcess;
  private readonly watching: Subscription[];
  private following: Following | undefined = undefined;

  constructor(private readonly options: ObsRuntimeOptions) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    this.process = new AttachedProcess(options.directory, {
      name: PROCESS_NAME,
      probe: signal => listening(options.websocketPort, signal),
      readyTimeoutMs: READY_TIMEOUT_MS
    });
    this.watching = [this.process.status$.subscribe(status => this.update(status))];
  }

  /**
   * Installs OBS and moq if need be, has OBS running with obs-websocket on, then the target following the spec's show.
   * Resolves once OBS answers; the target converges on its own, and reconnects to OBS when it restarts.
   */
  async execute(spec: ObsSpec, signal: AbortSignal): Promise<void> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      throw new Error(`OBS agents run on Windows and macOS, not ${process.platform}`);
    }
    const { directory, websocketPort } = this.options;
    const installed = await this.installed(obsBinary, this.options.binary, signal);
    this.update({ version: installed.version });
    const moq = await this.installed(moqBinary, this.options.moq, signal);
    const password = await websocketPassword(directory);
    const launch = obsLaunch(installed.path, directory);
    await writeObsSettings(launch.config, websocketPort, password);
    await this.process.ensure(
      { key: installed.id, binary: installed.path, args: launch.args, cwd: launch.cwd, env: launch.env },
      signal
    );
    this.follow(spec.show, password, moq.path);
    await this.binaries.prune(installed, { spare: 1 });
    await this.binaries.prune(moq, { spare: 1 });
  }

  /** The install of `manifest`, downloading it if need be. */
  private async installed(
    binary: typeof obsBinary | typeof moqBinary,
    manifest: ObsManifest | MoqManifest,
    signal: AbortSignal
  ): Promise<Installed> {
    const found = await this.binaries.find(manifest);
    if (found !== undefined) return found;
    this.update({ installing: true });
    try {
      return await this.binaries.install(binary, manifest, signal);
    } finally {
      this.update({ installing: false });
    }
  }

  /** The target following `show`: kept while it is the same show, replaced for another. */
  private follow(show: ObsSpec['show'], password: string, moq: string): void {
    if (this.following?.show.id === show.id && this.following.show.url === show.url) return;
    this.unfollow();
    const { studio, identity, directory, websocketPort } = this.options;
    const target = obsTarget({
      url: `ws://127.0.0.1:${String(websocketPort)}`,
      password,
      dir: join(directory, 'vignette'),
      sources: [ctvStreamObs({ studio, moq, directory: join(directory, 'relays') })]
    });
    const stop = target.follow(showStream(show.url, identity));
    const watching = target.subscribe(() => this.update({ phase: target.status.phase }));
    this.following = { show, target, stop, watching };
    this.update({ show: show.id, phase: target.status.phase });
  }

  private unfollow(): void {
    const following = this.following;
    this.following = undefined;
    if (following === undefined) return;
    following.watching();
    following.stop();
    void following.target.dispose();
    this.update({ show: null, phase: null });
  }

  /** The key is absent: stop following, and stop OBS. */
  async finalize(): Promise<void> {
    this.unfollow();
    await this.process.stop();
  }

  /** The agent is stopping, and OBS goes with it. */
  dispose(): void {
    this.unfollow();
    for (const subscription of this.watching) subscription.unsubscribe();
    this.process.dispose();
  }

  private update(changes: Partial<ObsStatus>): void {
    this.status$.next({ ...this.status$.value, ...changes });
  }
}

/** Whether obs-websocket accepts connections on `port`: OBS is up, and its server on. */
function listening(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const socket = dial({ host: '127.0.0.1', port, signal });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
