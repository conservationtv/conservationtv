import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BinaryStore, type Installed } from '@conservationtv/converge/binaries';
import { AttachedProcess, type ProcessStatus, STOPPED as PROCESS_STOPPED } from '@conservationtv/converge/process';
import {
  MediamtxAuthSchema,
  MediamtxTlsSchema,
  type DeviceIdentity,
  type MediamtxAuth
} from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { BehaviorSubject, type Subscription } from 'rxjs';
import { z } from 'zod';
import { lanAddresses } from '../addresses.ts';
import { type MediamtxManifest, mediamtxBinary } from './binaries/mediamtx.ts';
import { type MoqManifest, moqBinary } from './binaries/moq.ts';
import { createMediamtxAuthApp, serveMediamtxAuth } from './auth.ts';
import { type MediamtxListening, MoqPublisherSchema, renderConfig } from './config.ts';
import { isMediamtxAlive, mediamtxVersion } from './control.ts';
import { type EndpointRegistration, type RealisedEndpoint, realisedEndpoints } from './endpoints.ts';
import { BroadcastJoiner } from './joiner.ts';
import { RelayTrafficReporter } from './relay-traffic.ts';
import type { AgentConfiguration } from '../../config.ts';
import { MediamtxPathsSchema, MediamtxPreviewPathSchema } from './paths.ts';
import { removeTlsFiles, writeTlsFiles, type TlsFiles } from './tls.ts';

const logger = getLogger(['agent', 'mediamtx']);

/** How long asking MediaMTX whether it is serving, or which version it is, may take. */
const SERVING_PROBE_TIMEOUT_MS = 2_000;

/** Where to read a relay's traffic stats: the URL to dial, carrying its token as `?jwt=`. */
const RelayStatsSourceSchema = z.object({ connect: z.url() });
export type RelayStatsSource = z.output<typeof RelayStatsSourceSchema>;

/** The streams to serve, who may read and publish them, and the exposures to publish from them. */
export const StreamsSpecSchema = z.object({
  /** The gateway MediaMTX serves as, whose endpoints are registered with the studio API while it serves. */
  gatewayId: z.string().optional(),
  /** The paths to serve, each delivering an exposure. None, without `auth`, serves any path. */
  paths: MediamtxPathsSchema.default([]),
  /** The paths shows' outputs publish their previews to, by token, for readers to read. */
  previews: z.array(MediamtxPreviewPathSchema).default([]),
  /** Admit readers and publishers on this machine, and others only by tokens the studio API signs as this agent for this gateway; without it, anyone. */
  auth: MediamtxAuthSchema.optional(),
  /** Exposures to publish to MoQ relays from what is served: each rendition run by MediaMTX, joined by the agent. */
  publishers: z.array(MoqPublisherSchema).default([]),
  /** The relays' traffic stats to report what they carry of the publishers' exposures from (relay-traffic.ts). */
  stats: z.array(RelayStatsSourceSchema).default([]),
  /** The certificate to serve TLS with, for the gateway's hostname; without it, everything is served in the clear. */
  tls: MediamtxTlsSchema.optional()
});
export type StreamsSpec = z.output<typeof StreamsSpecSchema>;

/** The room the runtime is given to run MediaMTX in, and the releases it runs. */
export interface MediamtxRuntimeOptions extends MediamtxListening {
  /** A directory of its own: vendored binaries under `binaries/`, certificates under `tls/`, and MediaMTX's config, log and pidfile. */
  directory: string;
  /** The MediaMTX release to run. */
  binary: MediamtxManifest;
  /** The moq CLI release the publishers run, installed beside MediaMTX while there are any. */
  moq: MoqManifest;
  /** The agent's identity, which the tokens MediaMTX admits by are signed as. */
  identity: DeviceIdentity;
  /** Where the gateway's endpoints are registered with the studio API while MediaMTX serves it (endpoints.ts). */
  registration: EndpointRegistration;
  /** The agent's configuration, which reports of what the relays carry are submitted with (relay-traffic.ts). */
  config: AgentConfiguration;
}

export interface MediamtxStatus extends ProcessStatus {
  /** The version of MediaMTX running, or being started. */
  version: string | null;
  /**
   * The version the MediaMTX serving says it is, once it serves: `version`, unless what answers is another release,
   * whose config the agent's may not fit.
   */
  servingVersion: string | null;
  /** Whether a binary is being downloaded and checked. */
  installing: boolean;
}

const STOPPED: MediamtxStatus = { ...PROCESS_STOPPED, version: null, servingVersion: null, installing: false };

/** The answering of MediaMTX's authentication requests (auth.ts): by which `auth`, and how to stop it. */
interface AuthAnswering {
  auth: MediamtxAuth;
  close: () => Promise<void>;
}

/**
 * The `streams` key, fulfilled by MediaMTX as the agent's own child, from a binary the runtime vendors itself. Its
 * options name a release, with a download and a checksum for each platform; the runtime installs it into its own
 * directory, writes the config beside it and has `AttachedProcess` run it for that install. A changed spec is a reload
 * in place, since MediaMTX re-reads its config file whenever it is written.
 *
 * MediaMTX lives and dies with the agent, as do the answers to its authentication requests (auth.ts) and the joined
 * broadcast of each exposure it publishes (joiner.ts): none of them is any use without the others. An agent restart
 * starts MediaMTX afresh. Once it serves, where its servers are reached is registered with the studio API as the
 * gateway's endpoints (endpoints.ts), for as long as it keeps running.
 */
export class MediamtxRuntime {
  readonly status$ = new BehaviorSubject<MediamtxStatus>(STOPPED);
  private readonly binaries: BinaryStore;
  private readonly process: AttachedProcess;
  private readonly watching: Subscription[];
  private readonly configFile: string;
  private readonly tlsDirectory: string;
  private answering: AuthAnswering | undefined;
  private readonly joiner = new BroadcastJoiner();
  private readonly traffic: RelayTrafficReporter;

  constructor(private readonly options: MediamtxRuntimeOptions) {
    this.traffic = new RelayTrafficReporter(options.config);
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    this.process = new AttachedProcess(options.directory, { name: 'mediamtx', probe: isMediamtxAlive });
    this.watching = [
      // A MediaMTX that is not running says nothing about its version.
      this.process.status$.subscribe(status =>
        this.update(status.state === 'running' ? status : { ...status, servingVersion: null })
      )
    ];
    this.configFile = join(options.directory, 'mediamtx.yml');
    this.tlsDirectory = join(options.directory, 'tls');
  }

  /**
   * Installs the release the options name if need be, answers its authentication requests, has a MediaMTX from it
   * serving the config, then joins its publishers' broadcasts and registers its endpoints. Resolves once MediaMTX is
   * serving.
   */
  async execute(spec: StreamsSpec, signal: AbortSignal): Promise<void> {
    const { binary, directory } = this.options;
    const installed = (await this.binaries.find(binary)) ?? (await this.install(signal));
    this.update({ version: installed.version });
    const moq = await this.installMoq(spec, signal);
    await this.answer(spec.auth);
    const config = await this.render(spec, moq);
    await this.applyConfig(config);
    await this.process.ensure(
      { key: installed.id, binary: installed.path, args: [this.configFile], cwd: directory },
      signal
    );
    await this.checkVersion(installed.version, signal);
    this.joiner.set(spec.publishers);
    this.traffic.set(
      spec.stats.map(({ connect }) => connect),
      spec.publishers
    );
    await this.register(spec);
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
    const close = await serveMediamtxAuth(this.options.reach.authListen, app);
    this.answering = { auth, close };
  }

  /** The moq CLI, installed if the spec has publishers for it to run. */
  private async installMoq(spec: StreamsSpec, signal: AbortSignal): Promise<Installed | undefined> {
    if (spec.publishers.length === 0) return undefined;
    const { moq } = this.options;
    return (await this.binaries.find(moq)) ?? (await this.binaries.install(moqBinary, moq, signal));
  }

  /**
   * Stops MediaMTX, including one orphaned by an agent killed outright. Then removes the vendored binaries too:
   * removing the key removes everything it put there.
   */
  async finalize(): Promise<void> {
    await this.options.registration.withdraw();
    this.joiner.close();
    this.traffic.close();
    await this.process.stop();
    await this.answer(undefined);
    await this.binaries.clear();
    await removeTlsFiles(this.tlsDirectory);
    this.update({ version: null, servingVersion: null });
  }

  /**
   * Reports the version the MediaMTX serving says it is, warning when it is not the release installed: the config is
   * written for that release (packages/mediamtx), and another may read it differently.
   */
  private async checkVersion(installed: string, signal: AbortSignal): Promise<void> {
    const probe = AbortSignal.any([signal, AbortSignal.timeout(SERVING_PROBE_TIMEOUT_MS)]);
    const serving = await mediamtxVersion(probe).catch(() => undefined);
    this.update({ servingVersion: serving ?? null });
    if (serving !== undefined && serving !== installed) {
      logger.warn('MediaMTX says it is {serving}, but {installed} was installed', { serving, installed });
    }
  }

  /** The agent is stopping, and MediaMTX goes with it, along with the joining and answering. */
  dispose(): void {
    for (const subscription of this.watching) subscription.unsubscribe();
    this.joiner.close();
    this.traffic.close();
    void this.answering?.close();
    this.process.dispose();
    this.status$.complete();
  }

  /**
   * Registers the spec's gateway's endpoints, renewed while MediaMTX serves, or withdraws them when it names none. The
   * hostname is the certificate's, if the spec has one.
   */
  private async register(spec: StreamsSpec): Promise<void> {
    const { registration } = this.options;
    if (spec.gatewayId === undefined) return registration.withdraw();
    const hostname = spec.tls?.hostname;
    registration.register(spec.gatewayId, () => this.realised(hostname));
  }

  /**
   * Where MediaMTX's servers are reached as it serves now: at the gateway's hostname with TLS, or at the address the
   * agent prefers without. None while it is not serving, or the agent has no address to give.
   */
  private async realised(hostname: string | undefined): Promise<RealisedEndpoint[]> {
    if (!(await this.serving())) return [];
    const { ports } = this.options;
    if (hostname !== undefined) return realisedEndpoints(ports, hostname, true);
    const [preferred] = await lanAddresses();
    if (preferred === undefined) return [];
    return realisedEndpoints(ports, preferred.address, false);
  }

  /**
   * Whether MediaMTX is serving, as its control API answers: what readers would find, whatever the agent believes it
   * started. Nothing else answers in its place while the agent runs it (converge's AttachedProcess refuses to start
   * then), so an answer is from this agent's MediaMTX.
   */
  private serving(): Promise<boolean> {
    const signal = AbortSignal.timeout(SERVING_PROBE_TIMEOUT_MS);
    return isMediamtxAlive(signal).catch(() => false);
  }

  /** Downloads and checks the release the options name, which the status reports while it lasts. */
  private install(signal: AbortSignal): Promise<Installed> {
    this.update({ installing: true });
    const { binary } = this.options;
    return this.binaries.install(mediamtxBinary, binary, signal).finally(() => this.update({ installing: false }));
  }

  /** The config MediaMTX is to serve for `spec`, with the files it names (its certificate's) written for it to read. */
  private async render(spec: StreamsSpec, moq: Installed | undefined): Promise<string> {
    const { paths, previews, auth, publishers } = spec;
    const publishing = moq === undefined ? undefined : { moq: moq.path, publishers };
    const tls = await this.writeTls(spec);
    return renderConfig({ ...this.options, paths, previews, auth, publishing, tls });
  }

  /**
   * Has MediaMTX serve `config`. Nothing else knows how it gets there. Today that means writing it to the file
   * MediaMTX is started with, which a running MediaMTX reloads whenever it is written, so it is only written when it
   * has changed.
   */
  private async applyConfig(config: string): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
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
