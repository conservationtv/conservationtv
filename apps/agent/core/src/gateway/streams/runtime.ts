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
import { lanAddresses } from '../../machine/addresses.ts';
import { type MediamtxManifest, mediamtxBinary } from '../../binaries/mediamtx.ts';
import { type MoqManifest, moqBinary } from '../../binaries/moq.ts';
import type { NodeCommand } from '../../config.ts';
import type { PortMove } from '../../machine/ports.ts';
import { type Journal, useJournal } from '../../reporting/journal.ts';
import { createMediamtxAuthApp, serveMediamtxAuth } from './auth.ts';
import { bindFailures, chooseMediamtxPorts, logEnd, rememberedPorts } from './chosen.ts';
import { MoqPublisherSchema, renderConfig } from './config.ts';
import { isMediamtxAlive, mediamtxVersion } from './control.ts';
import { type EndpointRegistration, type RealisedEndpoint, realisedEndpoints } from './endpoints.ts';
import type { GatewayListening } from './listening.ts';
import { keyDigestsOf, MediamtxPathsSchema, MediamtxPreviewPathSchema } from './paths.ts';
import { type MediamtxPortPins, PORT_USES, type PortRole } from './ports.ts';
import { PushedPublishers } from './pushed.ts';
import { RelayCheck } from './relay-check.ts';
import { removeTlsFiles, writeTlsFiles, type TlsFiles } from './tls.ts';

const logger = getLogger(['agent', 'mediamtx']);

/** How long asking MediaMTX whether it is serving, or which version it is, may take. */
const SERVING_PROBE_TIMEOUT_MS = 2_000;

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
  /** Exposures to publish to MoQ relays from what is served: each a moq CLI MediaMTX runs, checked on the relay by the agent. */
  publishers: z.array(MoqPublisherSchema).default([]),
  /** The certificate to serve TLS with, for the gateway's hostname; without it, everything is served in the clear. */
  tls: MediamtxTlsSchema.optional()
});
export type StreamsSpec = z.output<typeof StreamsSpecSchema>;

/** The room the runtime is given to run MediaMTX in, and the releases it runs. */
export interface MediamtxRuntimeOptions {
  /** The ports pinned for MediaMTX, used as given (ports.ts). */
  pins: MediamtxPortPins;
  /** Where MediaMTX listens, set here before each start of it, and read by everything that reaches it. */
  listening: GatewayListening;
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
  /** How to run the hook a pushed path runs while it is published (pushed.ts); its `env` is MediaMTX's, which it inherits. */
  node: NodeCommand;
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

/** What the latest spec has MediaMTX serve, which each start of it, and each reload, is configured from. */
interface Serving {
  spec: StreamsSpec;
  moq: Installed | undefined;
  /** The hook every pushed path runs (pushed.ts). */
  available: string;
  tls: TlsFiles | undefined;
}

/**
 * The `streams` key, fulfilled by MediaMTX as the agent's own child, from a binary the runtime vendors itself. Its
 * options name a release, with a download and a checksum for each platform; the runtime installs it into its own
 * directory, writes the config beside it and has `AttachedProcess` run it for that install. A changed spec is a reload
 * in place, since MediaMTX re-reads its config file whenever it is written.
 *
 * MediaMTX lives and dies with the agent, as do the answers to its authentication requests (auth.ts), the publishers
 * of its pushed paths (pushed.ts) and the check on the relay of each exposure it publishes (relay-check.ts): none of
 * them is any use without the others. An agent restart
 * starts MediaMTX afresh. Once it serves, where its servers are reached is registered with the studio API as the
 * gateway's endpoints (endpoints.ts), for as long as it keeps running.
 *
 * Its ports are chosen before each start of it, and only then (ports.ts, chosen.ts): by the run's `prepare`, which
 * converge's AttachedProcess calls once the MediaMTX before is gone, whether `execute` starts it or it is started
 * again after dying. A start that fails to bind fails `execute`, or the restart, and the next one chooses again,
 * keeping off the ports MediaMTX said it could not bind. While it runs, a changed spec reloads it on the same ports.
 */
export class MediamtxRuntime {
  readonly status$ = new BehaviorSubject<MediamtxStatus>(STOPPED);
  private readonly binaries: BinaryStore;
  private readonly process: AttachedProcess;
  private readonly watching: Subscription[];
  private readonly configFile: string;
  private readonly tlsDirectory: string;
  private answering: AuthAnswering | undefined;
  /** Each pushed path's key digest, as the spec served now names them, which the answers read at every ask. */
  private keyDigests: ReadonlyMap<string, string> = new Map();
  private readonly relayCheck = new RelayCheck();
  private readonly pushed: PushedPublishers;
  private readonly journal: Journal;
  /** What the latest spec has MediaMTX serve; none before the first. */
  private serving: Serving | undefined = undefined;
  /** Whether the ports chosen last time have been read, for an orphaned MediaMTX to be found on. */
  private recalled = false;
  /** Where in its log the MediaMTX started last began, to read why it failed from. */
  private startedAt: number | undefined = undefined;

  constructor(private readonly options: MediamtxRuntimeOptions) {
    this.binaries = new BinaryStore({ directory: join(options.directory, 'binaries') });
    const { listening } = options;
    this.pushed = new PushedPublishers(join(options.directory, 'pushed'), listening.api, () => listening.reach.rtmp);
    this.journal = useJournal();
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
   * Installs the release the options name if need be, has a MediaMTX from it serving the config (started on ports
   * chosen for it, by `prepare`, if it is not running) with its authentication requests answered, then checks its
   * publishers' broadcasts on the relay and registers its endpoints. Resolves once MediaMTX is serving.
   */
  async execute(spec: StreamsSpec, signal: AbortSignal): Promise<void> {
    const { binary, directory, node } = this.options;
    const keyDigests = keyDigestsOf(spec.paths);
    // A key is checked only by the agent's answers, which only `auth` has MediaMTX ask for: without it, a keyed path
    // would admit anyone. Refused here rather than by the schema, which is the agent's published `system.spec`.
    if (spec.auth === undefined && keyDigests.size > 0) {
      throw new Error('A pushed path has a stream key, but the spec admits anyone: it names no `auth`');
    }
    const installed = (await this.binaries.find(binary)) ?? (await this.install(signal));
    this.update({ version: installed.version });
    const moq = await this.installMoq(spec, signal);
    this.keyDigests = keyDigests;
    const available = await this.pushed.command(node.path);
    const tls = await this.writeTls(spec);
    this.serving = { spec, moq, available, tls };
    await this.recall();
    const run = {
      key: installed.id,
      binary: installed.path,
      args: [this.configFile],
      cwd: directory,
      env: node.env,
      prepare: () => this.prepare()
    };
    await this.process.ensure(run, signal).catch((error: Error) => this.explain(error));
    // Running, on the ports it was started on: whatever changed since is answered and reloaded in place on them.
    await this.answer(spec.auth);
    await this.applyConfig(await this.render());
    await this.checkVersion(installed.version, signal);
    this.pushed.set(moq && { moq: moq.path, publishers: pushedPublishers(spec) });
    this.relayCheck.set(spec.publishers);
    await this.register(spec);
    await this.binaries.prune(installed, { spare: 1 });
    if (moq !== undefined) await this.binaries.prune(moq, { spare: 1 });
  }

  /**
   * Readies MediaMTX's start, once the one before is gone (converge's `prepare`): chooses its ports, keeping off those
   * the last start could not bind, answers its authentication requests on its own, and writes its config for them.
   * Throws if a pinned port is in use, failing the start.
   */
  private async prepare(): Promise<void> {
    const { directory, pins, listening } = this.options;
    const serving = this.serving;
    if (serving === undefined) throw new Error('MediaMTX has no spec to serve');
    const unbound = await this.unbound();
    this.startedAt = undefined;
    for (const [port, said] of unbound) {
      logger.warn('MediaMTX could not listen on port {port} as it started: {said}', { port, said });
    }
    // Nothing asks while no MediaMTX runs, and the answers' port is chosen with the rest.
    await this.stopAnswering();
    const { ports, moved } = await chooseMediamtxPorts(directory, pins, new Set(unbound.keys()));
    for (const move of moved) this.moved(move);
    listening.set(ports);
    await this.answer(serving.spec.auth);
    await this.applyConfig(await this.render());
    this.startedAt = await logEnd(this.process.log);
  }

  /** Says a port moved: a warning and an event for one readers use, only a note for one on loopback. */
  private moved({ role, wanted, chosen }: PortMove<PortRole>): void {
    if (PORT_USES[role].scope === 'loopback') {
      logger.info('MediaMTX {role} port {wanted} is unavailable, so it is on {chosen}', { role, wanted, chosen });
      return;
    }
    logger.warn('MediaMTX {role} port {wanted} is unavailable, so it listens on {chosen}', { role, wanted, chosen });
    this.journal.event('mediamtx.port.moved', { key: 'streams', role, wanted, chosen });
  }

  /**
   * Where MediaMTX was started last time, before the first start of this agent's: an orphan of an agent killed outright
   * answers there, and is stopped before the new one starts.
   */
  private async recall(): Promise<void> {
    if (this.recalled) return;
    this.recalled = true;
    const { directory, pins, listening } = this.options;
    const remembered = await rememberedPorts(directory);
    listening.set({ ...listening.ports, ...remembered, ...pins });
  }

  /** The ports MediaMTX said it could not listen on as it was last started, and what it said. */
  private unbound(): Promise<Map<number, string>> {
    if (this.startedAt === undefined) return Promise.resolve(new Map());
    return bindFailures(this.process.log, this.startedAt);
  }

  /** A failed start, with what MediaMTX said of the ports it could not listen on. */
  private async explain(error: Error): Promise<never> {
    const unbound = await this.unbound();
    if (unbound.size === 0) throw error;
    throw new Error(`${error.message}: ${[...unbound.values()].join('; ')}`, { cause: error });
  }

  /**
   * Answers MediaMTX's authentication requests by `auth`, on its port (`reach.authListen`), or stops answering
   * without it. Only a changed `auth` restarts the answering, which refuses for the moment it is down.
   */
  private async answer(auth: MediamtxAuth | undefined): Promise<void> {
    if (JSON.stringify(auth) === JSON.stringify(this.answering?.auth)) return;
    await this.stopAnswering();
    if (auth === undefined) return;
    const app = createMediamtxAuthApp(auth, this.options.identity, () => this.keyDigests);
    const close = await serveMediamtxAuth(this.options.listening.reach.authListen, app);
    this.answering = { auth, close };
  }

  private async stopAnswering(): Promise<void> {
    const answering = this.answering;
    this.answering = undefined;
    await answering?.close();
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
    this.relayCheck.close();
    await this.pushed.close();
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

  /** The agent is stopping, and MediaMTX goes with it, along with the checking and answering. */
  dispose(): void {
    for (const subscription of this.watching) subscription.unsubscribe();
    this.relayCheck.dispose();
    this.pushed.dispose();
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
    if (!(await this.answers())) return [];
    const { ports } = this.options.listening;
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
  private answers(): Promise<boolean> {
    const signal = AbortSignal.timeout(SERVING_PROBE_TIMEOUT_MS);
    return isMediamtxAlive(signal).catch(() => false);
  }

  /** Downloads and checks the release the options name, which the status reports while it lasts. */
  private install(signal: AbortSignal): Promise<Installed> {
    this.update({ installing: true });
    const { binary } = this.options;
    return this.binaries.install(mediamtxBinary, binary, signal).finally(() => this.update({ installing: false }));
  }

  /** The config MediaMTX is to serve for the latest spec, on the ports it listens on now. */
  private async render(): Promise<string> {
    if (this.serving === undefined) throw new Error('MediaMTX has no spec to serve');
    const { spec, moq, available, tls } = this.serving;
    const { paths, previews, auth, publishers } = spec;
    const publishing = moq === undefined ? undefined : { moq: moq.path, publishers };
    const { ports, reach } = this.options.listening;
    return renderConfig({ ports, reach, paths, previews, auth, publishing, available, tls });
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

/** The publishers reading a pushed path (no source), which the agent runs itself (pushed.ts). */
function pushedPublishers(spec: StreamsSpec) {
  const pushed = new Set(spec.paths.filter(path => path.source === undefined).map(path => path.name));
  return spec.publishers.filter(publisher => pushed.has(publisher.path));
}
