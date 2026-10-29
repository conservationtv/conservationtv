import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { AdoptedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import {
  MediamtxAuthSchema,
  MediamtxTlsSchema,
  type DeviceIdentity,
  type MediamtxAuth
} from '@conservationtv/studio-sdk';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import { type MediamtxManifest, mediamtxBinary } from './binaries/mediamtx.ts';
import { type MoqManifest, moqBinary } from './binaries/moq.ts';
import { createMediamtxAuthApp, serveMediamtxAuth } from './auth.ts';
import { type MediamtxAddresses, MoqPublisherSchema, renderConfig } from './config.ts';
import { isMediamtxAlive } from './control.ts';
import { BroadcastJoiner } from './joiner.ts';
import { MediamtxPathsSchema } from './paths.ts';
import { removeTlsFiles, writeTlsFiles, type TlsFiles } from './tls.ts';

/** The streams to serve, who may read and publish them, and the exposures to publish from them. */
export const StreamsSpecSchema = z.object({
  /** The paths to serve, each delivering an exposure. None, without `auth`, serves any path. */
  paths: MediamtxPathsSchema.default([]),
  /** Admit readers and publishers on this machine, and others only by tokens the studio API signs as this agent for this gateway; without it, anyone. */
  auth: MediamtxAuthSchema.optional(),
  /** Exposures to publish to MoQ relays from what is served: each rendition run by MediaMTX, joined by the agent. */
  publishers: z.array(MoqPublisherSchema).default([]),
  /** The certificate to serve TLS with, for the gateway's hostname; without it, everything is served in the clear. */
  tls: MediamtxTlsSchema.optional()
});
export type StreamsSpec = z.output<typeof StreamsSpecSchema>;

/** The room the runtime is given to run MediaMTX in, and the releases it runs. */
export interface MediamtxRuntimeOptions extends MediamtxAddresses {
  /** A directory of its own: vendored binaries under `binaries/`, certificates under `tls/`, and MediaMTX's config, pidfile and log. */
  directory: string;
  /** The MediaMTX release to run. */
  binary: MediamtxManifest;
  /** The moq CLI release the publishers run, installed beside MediaMTX while there are any. */
  moq: MoqManifest;
  /** The agent's identity, which the tokens MediaMTX admits by are signed as. */
  identity: DeviceIdentity;
}

export interface MediamtxStatus extends ProcessStatus {
  /** The version of MediaMTX running, or being started. */
  version: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
}

const STOPPED: MediamtxStatus = { ...PROCESS_STOPPED, version: null, installing: false };

/** The answering of MediaMTX's authentication requests (auth.ts): by which `auth`, and how to stop it. */
interface AuthAnswering {
  auth: MediamtxAuth;
  close: () => Promise<void>;
}

/**
 * The `streams` key, fulfilled by MediaMTX as a process of its own, outliving the agent, from a binary the runtime
 * vendors itself. Its options name a release, with a download and a checksum for each platform; the runtime installs
 * it into its own directory, writes the config beside it and has `AdoptedProcess` run it for that install: a MediaMTX
 * left by an earlier agent is adopted if it came from the install the options now name, and replaced otherwise, so a
 * changed spec is a reload in place while an agent with a new release replaces the process. Only removing the key,
 * through `finalize`, stops MediaMTX.
 *
 * Beside it, in the agent: the answers to MediaMTX's authentication requests (auth.ts), and the joined broadcast of
 * each exposure it publishes (joiner.ts). Both stop with the agent, while MediaMTX goes on.
 */
export class MediamtxRuntime {
  readonly status$ = new BehaviorSubject<MediamtxStatus>(STOPPED);
  private readonly binaries: BinaryStore;
  private readonly process: AdoptedProcess;
  private readonly watching: Subscription[];
  private readonly configFile: string;
  private readonly tlsDirectory: string;
  private answering: AuthAnswering | undefined;
  private readonly joiner = new BroadcastJoiner();

  constructor(private readonly options: MediamtxRuntimeOptions) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    this.process = new AdoptedProcess(options.directory, { name: 'mediamtx', probe: isMediamtxAlive });
    this.watching = [this.process.status$.subscribe(status => this.update(status))];
    this.configFile = join(options.directory, 'mediamtx.yml');
    this.tlsDirectory = join(options.directory, 'tls');
  }

  /**
   * Installs the release the options name if need be, answers its authentication requests, has a MediaMTX from it
   * serving the config, then joins its publishers' broadcasts. Resolves once MediaMTX is serving.
   */
  async execute(spec: StreamsSpec, signal: AbortSignal): Promise<void> {
    const { binary, directory } = this.options;
    const installed = (await this.binaries.find(binary)) ?? (await this.install(signal));
    this.update({ version: installed.version });
    const moq = await this.installMoq(spec, signal);
    await this.answer(spec.auth);
    await this.writeConfig(spec, moq);
    await this.process.ensure(
      { key: installed.id, binary: installed.path, args: [this.configFile], cwd: directory },
      signal
    );
    this.joiner.set(spec.publishers);
    await this.binaries.prune(installed, { spare: 1 });
    if (moq !== undefined) await this.binaries.prune(moq, { spare: 1 });
  }

  /**
   * Answers MediaMTX's authentication requests by `auth`, or stops answering without it. Only a changed `auth`
   * restarts the answering, which refuses for the moment it is down.
   */
  private async answer(auth: MediamtxAuth | undefined): Promise<void> {
    if (JSON.stringify(auth) === JSON.stringify(this.answering?.auth)) return;
    await this.answering?.close();
    this.answering = undefined;
    if (auth === undefined) return;
    const app = createMediamtxAuthApp(auth, this.options.identity);
    const close = await serveMediamtxAuth(this.options.authHttp, app);
    this.answering = { auth, close };
  }

  /** The moq CLI, installed if the spec has publishers for it to run. */
  private async installMoq(spec: StreamsSpec, signal: AbortSignal): Promise<Installed | undefined> {
    if (spec.publishers.length === 0) return undefined;
    const { moq } = this.options;
    return (await this.binaries.find(moq)) ?? (await this.binaries.install(moqBinary, moq, signal));
  }

  /**
   * Stops MediaMTX, whichever binary it came from, including one left running by an earlier agent. Then removes the
   * vendored binaries too: removing the key removes everything it put there.
   */
  async finalize(): Promise<void> {
    this.joiner.close();
    await this.process.stop();
    await this.answer(undefined);
    await this.binaries.clear();
    await removeTlsFiles(this.tlsDirectory);
    this.update({ version: null });
  }

  /**
   * The agent is stopping. MediaMTX is left running for the next agent to adopt; the watching, joining and answering
   * stop, so until then MediaMTX admits no one and its publishers' broadcasts go unjoined.
   */
  dispose(): void {
    for (const subscription of this.watching) subscription.unsubscribe();
    this.joiner.close();
    void this.answering?.close();
    this.process.dispose();
    this.status$.complete();
  }

  /** Downloads and checks the release the options name, which the status reports while it lasts. */
  private install(signal: AbortSignal): Promise<Installed> {
    this.update({ installing: true });
    const { binary } = this.options;
    return this.binaries.install(mediamtxBinary, binary, signal).finally(() => this.update({ installing: false }));
  }

  /**
   * Writes the config before MediaMTX reads it, or re-reads it: a running MediaMTX reloads its file whenever it is
   * written, so one already serving this config is left undisturbed.
   */
  private async writeConfig(spec: StreamsSpec, moq: Installed | undefined): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    const { paths, auth, publishers } = spec;
    const publishing = moq === undefined ? undefined : { moq: moq.path, publishers };
    const tls = await this.writeTls(spec);
    const config = await renderConfig({ ...this.options, paths, auth, publishing, tls });
    const written = await readFile(this.configFile, 'utf8').catch(() => undefined);
    if (written !== config) await writeFile(this.configFile, config);
  }

  /** The certificate's files, written for MediaMTX to read, or none, with any earlier certificate's removed. */
  private async writeTls(spec: StreamsSpec): Promise<TlsFiles | undefined> {
    if (spec.tls === undefined) {
      await removeTlsFiles(this.tlsDirectory);
      return undefined;
    }
    return writeTlsFiles(this.tlsDirectory, spec.tls);
  }

  private update(change: Partial<MediamtxStatus>): void {
    if (this.status$.closed) return;
    const current = this.status$.getValue();
    this.status$.next({ ...current, ...change });
  }
}
