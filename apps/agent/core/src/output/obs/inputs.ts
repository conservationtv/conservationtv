import { join } from 'node:path';
import type { Client } from '@conservationtv/studio-sdk';
import { BehaviorSubject } from 'rxjs';
import { PathHolds } from '../../mediamtx/hold.ts';
import { inputOf, inputPath, type ProgramMediamtx } from './program.ts';
import { Relay, RESTART_SPACING_MS, RETRY_MS, StudioTooOldError } from './relay.ts';

// The streams OBS plays, whoever drives its scenes: the show (output/show/ctv-stream.ts), or something outside the
// studio. OBS reads any of its organisation's streams from the program MediaMTX, at `inputs/<stream>` (program.ts),
// whatever delivers it, and the agent relays it there for as long as something reads it:
//
//   OBS reads inputs/<s>  ─▶  MediaMTX runs the demand launcher (`runOnDemand`, mediamtx/hold.ts)
//                               │ holds a request to the agent's hold server open while it runs
//                               ▼
//   a relay per stream (relay.ts), by whatever the studio API says delivers it:
//     MoQ          moq --broadcast <name> export rtmp --connect rtmp://…/inputs/<s>       (MOQ_CONNECT=<relay?jwt=…>)
//     RTSP, RTMP   mediamtx pull.yml: its one path pulling the gateway, forwarding to rtmp://…/inputs/<s>
//
// The launcher's one request says which path is wanted and, by staying open, for how long: MediaMTX stops it once
// nothing reads the path, or once MediaMTX itself is gone. The first time a stream is wanted, its
// relay asks the studio API how to read it, as its device (`organisations.streams.connect`): the API chooses the
// delivery, and admits what the output may play (src/gateways/connect.ts). Either relay passes the stream's tracks
// through as they are, with no offline segment of MediaMTX's behind them: one would have to declare exactly the tracks
// the camera sends, codec, sample rate and channels, and MediaMTX can't make one for many a camera's audio. What OBS
// shows while an input is down is the show's to decide. A relay is stopped once nothing has read it for
// `RELEASE_AFTER_MS`.
//
// No relay changes the program MediaMTX's config: each publishes into the one input pattern. Restarting a relay is a
// gap in its input, so the relays' restarts are kept `RESTART_SPACING_MS` apart (`book`). A stream's relays share its
// folder, and with it their processes' pidfiles, so a stream's next relay starts only once its last has stopped: one
// still stopping would otherwise find the new one's process by its pidfile, and stop it.
//
// A studio API that doesn't serve `organisations.streams.connect` is older than this agent: no stream can be relayed
// until it is updated, so nothing is asked for `RETRY_MS` after it said so (each relay that asked logs why it failed),
// rather than again on every reader OBS sends.

/** How long a stream is relayed after the last reader goes. */
const RELEASE_AFTER_MS = 30_000;

/**
 * What the relays need: the studio API, as the device, the program MediaMTX, the Node it runs the launcher with, and a
 * folder of their own.
 */
export interface InputRelaysOptions {
  studio: Client;
  program: ProgramMediamtx;
  /** The Node executable; whatever else it needs is in the program MediaMTX's environment, which it inherits. */
  node: string;
  directory: string;
}

/** What is relayed: for each stream's path, how many read it now. */
export interface InputsStatus {
  reading: Record<string, number>;
}

/** The CLIs the relays run: an installed moq CLI and MediaMTX. */
export interface RelayBinaries {
  moq: string;
  mediamtx: string;
}

/** One stream being relayed: the relay, how many read it, and when it is let go of when none does. */
interface Wanted {
  relay: Relay;
  readers: number;
  release: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The streams OBS plays, relayed into the program MediaMTX while they are read, for the organisation `serve` names.
 * Its hold server listens on loopback from `serve` until `stop` or `dispose`.
 */
export class InputRelays {
  readonly status$ = new BehaviorSubject<InputsStatus>({ reading: {} });
  private readonly holds = new PathHolds(path => this.held(path));
  private readonly wanted = new Map<string, Wanted>();
  /** When each stream's relay restarts next, as booked: kept `RESTART_SPACING_MS` apart. */
  private readonly restarts = new Map<string, number>();
  /** Each stream's relays stopping, by the stream, until they have: its next relay starts after. */
  private readonly stopping = new Map<string, Promise<void>>();
  /** Until when (epoch milliseconds) nothing is relayed, the studio API having said it is too old to ask. */
  private unsupportedUntil = 0;
  private binaries: RelayBinaries | undefined = undefined;
  private organisationId: string | undefined = undefined;

  constructor(private readonly options: InputRelaysOptions) {}

  /**
   * Relay the organisation's streams, by the CLIs installed at `binaries`: the hold server listening, the launcher
   * written, and the program MediaMTX told to run it.
   */
  async serve(organisationId: string, binaries: RelayBinaries): Promise<void> {
    if (this.organisationId !== undefined && this.organisationId !== organisationId) this.releaseAll();
    this.organisationId = organisationId;
    this.binaries = binaries;
    const launcher = join(this.options.directory, 'demand.mjs');
    const command = await this.holds.command(this.options.node, launcher);
    await this.options.program.setDemand(command);
  }

  /** Where OBS reads the stream, at the program MediaMTX. */
  url(streamId: string): string {
    return this.options.program.pathUrl(inputPath(streamId));
  }

  /** Stop relaying anything, and stop listening. */
  async stop(): Promise<void> {
    this.releaseAll();
    await this.options.program.setDemand(undefined);
    await this.holds.close();
  }

  dispose(): void {
    this.releaseAll();
    this.holds.dispose();
  }

  /** A launcher's request: an input's path is wanted until it closes. Any other path is refused. */
  private held(path: string): (() => void) | undefined {
    const streamId = inputOf(path);
    if (streamId === undefined) return undefined;
    this.acquire(path, streamId);
    return () => this.release(path);
  }

  /** One more reader of the stream: its relay started if it isn't running, once the stream's last has stopped. */
  private acquire(path: string, streamId: string): void {
    const { binaries, organisationId } = this;
    if (binaries === undefined || organisationId === undefined) return;
    if (Date.now() < this.unsupportedUntil) return;
    let wanted = this.wanted.get(path);
    if (wanted === undefined) {
      const { studio, program, directory } = this.options;
      const book = (at: number) => this.book(streamId, at);
      const options = { studio, program, ...binaries, directory: join(directory, streamId), book };
      const relay = new Relay(options, { organisationId, streamId }, path);
      wanted = { relay, readers: 0, release: undefined };
      this.wanted.set(path, wanted);
      const stopping = this.stopping.get(streamId);
      const started = stopping === undefined ? relay.start() : stopping.then(() => relay.start());
      // One that cannot start is let go of now, for the next reader to try afresh.
      started.catch((error: Error) => {
        if (error instanceof StudioTooOldError) this.unsupported();
        if (this.wanted.get(path)?.relay === relay) this.drop(path);
      });
    }
    clearTimeout(wanted.release);
    wanted.release = undefined;
    wanted.readers += 1;
    this.report();
  }

  /** The studio API is too old to say how to read a stream: nothing is asked of it for a while. */
  private unsupported(): void {
    this.unsupportedUntil = Date.now() + RETRY_MS;
  }

  /** One reader fewer: with none, the relay is stopped once none has come back for a while. */
  private release(path: string): void {
    const wanted = this.wanted.get(path);
    if (wanted === undefined) return;
    wanted.readers = Math.max(wanted.readers - 1, 0);
    if (wanted.readers === 0) wanted.release = setTimeout(() => this.drop(path), RELEASE_AFTER_MS);
    this.report();
  }

  /**
   * When the stream's relay may restart, wanted at `at`: the soonest from then at least `RESTART_SPACING_MS` from every
   * other relay's booked restart. Restarts long past are forgotten.
   */
  private book(streamId: string, at: number): number {
    this.restarts.delete(streamId);
    for (const [other, booked] of this.restarts) if (booked < at - RESTART_SPACING_MS) this.restarts.delete(other);
    const slot = spacedFrom([...this.restarts.values()], at, RESTART_SPACING_MS);
    this.restarts.set(streamId, slot);
    return slot;
  }

  private drop(path: string): void {
    const wanted = this.wanted.get(path);
    if (wanted === undefined) return;
    clearTimeout(wanted.release);
    this.wanted.delete(path);
    const streamId = inputOf(path);
    const stopped = wanted.relay.stop();
    if (streamId !== undefined) {
      this.restarts.delete(streamId);
      this.stopped(streamId, stopped);
    }
    this.report();
  }

  /** The stream's relays stopping, `stopped` among them, until all have: forgotten once they have. */
  private stopped(streamId: string, stopped: Promise<void>): void {
    const earlier = this.stopping.get(streamId);
    const all = Promise.all([earlier, stopped]).then(
      () => undefined,
      () => undefined
    );
    this.stopping.set(streamId, all);
    void all.then(() => {
      if (this.stopping.get(streamId) === all) this.stopping.delete(streamId);
    });
  }

  private releaseAll(): void {
    for (const path of this.wanted.keys()) this.drop(path);
  }

  private report(): void {
    const reading = Object.fromEntries([...this.wanted].map(([path, wanted]) => [path, wanted.readers]));
    this.status$.next({ reading });
  }
}

/** The soonest time from `at` at least `spacing` from every one of `booked`. */
export function spacedFrom(booked: number[], at: number, spacing: number): number {
  let slot = at;
  for (const other of [...booked].sort((a, b) => a - b)) if (Math.abs(other - slot) < spacing) slot = other + spacing;
  return slot;
}
