import type { ResolvedVideo } from './resolve.ts';
import type { Target } from './sink.ts';

// Adapting a rendition to what the device and the network can take, without thrashing. A rendition is encoded at its
// quality's own bitrate (Mediabunny's, for its size) unless the network's ceiling is lower, when it is held to that;
// the CPU's pressure (the Compute Pressure API, where there is one) sets the frame rate and size, which are what
// actually cost an encoder. Each change is held a while before it is made, longer going up than down, so
// a moment's dip neither restarts an encoder nor bounces the picture.

/** How loaded the CPU is, as the Compute Pressure API says. */
export type PressureState = 'nominal' | 'fair' | 'serious' | 'critical';

/** How long a lower ceiling must last before the bitrate follows it down, in milliseconds. */
const DOWN_AFTER_MS = 1_500;

/** How long a higher ceiling (or easier pressure) must last before going back up. */
const UP_AFTER_MS = 10_000;

/** The share of a ceiling to encode at, leaving room for the frames a VBR encoder bursts past its average. */
const HEADROOM = 0.85;

/** The least a rendition is ever encoded at, as a share of its quality's bitrate: below it, a frame is mud. */
const FLOOR = 0.2;

/** A change smaller than this share of the current bitrate is not worth restarting an encoder for. */
const DEADBAND = 0.2;

/** What a rendition keeps under pressure: shares of its frame rate and of each side. */
interface Relief {
  frameRate: number;
  scale: number;
}

/** What pressure takes from a rendition: of its frame rate and of each side, by what it shows. */
function relief(state: PressureState, content: ResolvedVideo['content']): Relief {
  // Motion keeps its frame rate as long as it can and gives up detail; a screen keeps its detail and gives up frames.
  if (state === 'serious') return content === 'motion' ? { frameRate: 1, scale: 0.75 } : { frameRate: 0.5, scale: 1 };
  if (state === 'critical')
    return content === 'motion' ? { frameRate: 0.5, scale: 0.5 } : { frameRate: 0.34, scale: 0.75 };
  return { frameRate: 1, scale: 1 };
}

/** A target's bitrate for comparing: the quality's own (no explicit bitrate) is the most it can be. */
function rate(target: Target): number {
  return target.bitrate ?? Number.POSITIVE_INFINITY;
}

/** Whether `next` is less than `current` in anything. */
function lower(next: Target, current: Target): boolean {
  return rate(next) < rate(current) || next.frameRate < current.frameRate || next.scale < current.scale;
}

/** Whether two bitrates differ enough to restart an encoder for: by the deadband, or one limited and one not. */
function bitratesDiffer(next: number | undefined, current: number | undefined): boolean {
  if (next === undefined || current === undefined) return next !== current;
  return Math.abs(next - current) > DEADBAND * current;
}

/** Whether `next` differs from `current` enough to act on. */
function differs(next: Target, current: Target): boolean {
  return (
    bitratesDiffer(next.bitrate, current.bitrate) ||
    next.frameRate !== current.frameRate ||
    next.scale !== current.scale
  );
}

/**
 * One rendition's target, from its resolved settings, its sinks' ceiling, and the CPU's pressure: `changed` is told
 * each target that has held long enough to act on.
 */
export class Governor {
  private readonly rendition: ResolvedVideo;
  private readonly onChange: (target: Target) => void;
  private ceilingBitrate: number | undefined = undefined;
  /** The quality's own bitrate at the rendition's full size, once its encoder has said. */
  private qualityBitrate: number | undefined = undefined;
  private pressureState: PressureState = 'nominal';
  private current: Target;
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private pending: Target | undefined = undefined;

  constructor(rendition: ResolvedVideo, changed: (target: Target) => void) {
    this.rendition = rendition;
    this.onChange = changed;
    this.current = { bitrate: rendition.bitrate, frameRate: rendition.frameRate, scale: 1 };
  }

  /** The bitrate the rendition's quality comes to at its full size, as its encoder was configured. */
  known(bitrate: number): void {
    if (this.qualityBitrate === bitrate) return;
    this.qualityBitrate = bitrate;
    this.review();
  }

  get target(): Target {
    return this.current;
  }

  /** The most the network can take, in bits per second; undefined for no opinion. */
  ceiling(bitrate: number | undefined): void {
    this.ceilingBitrate = bitrate;
    this.review();
  }

  pressure(state: PressureState): void {
    this.pressureState = state;
    this.review();
  }

  close(): void {
    clearTimeout(this.timer);
  }

  /**
   * The target its inputs call for now. Fewer pixels and frames need fewer bits for the same quality, which the
   * quality's bitrate follows by itself; only a ceiling below what it would spend holds it to an explicit bitrate.
   */
  private wanted(): Target {
    const { frameRate, content } = this.rendition;
    const eased = relief(this.pressureState, content);
    const target: Target = {
      bitrate: this.rendition.bitrate,
      frameRate: Math.max(1, Math.round(frameRate * eased.frameRate)),
      scale: eased.scale
    };
    const full = this.rendition.bitrate ?? this.qualityBitrate;
    if (this.ceilingBitrate === undefined || full === undefined) return target;
    const spend = full * eased.scale * eased.scale * Math.min(1, 0.5 + eased.frameRate / 2);
    const allowed = this.ceilingBitrate * HEADROOM;
    if (allowed < spend) target.bitrate = Math.round(Math.max(allowed, full * FLOOR));
    return target;
  }

  /** Hold a change until it has lasted, then make it; one that goes away meanwhile is forgotten. */
  private review(): void {
    const next = this.wanted();
    if (!differs(next, this.current)) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pending = undefined;
      return;
    }
    const down = lower(next, this.current);
    // A pending change in the same direction keeps its clock, taking the newer target; a reversal starts afresh.
    if (this.pending !== undefined && lower(this.pending, this.current) === down) {
      this.pending = next;
      return;
    }
    clearTimeout(this.timer);
    this.pending = next;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const pending = this.pending;
        this.pending = undefined;
        if (pending === undefined) return;
        this.current = pending;
        this.onChange(pending);
      },
      down ? DOWN_AFTER_MS : UP_AFTER_MS
    );
  }
}

/** The Compute Pressure API's observer, where the browser has one. */
interface PressureRecord {
  state: PressureState;
}
interface PressureObserveOptions {
  sampleInterval?: number;
}
interface PressureObserverLike {
  observe(source: 'cpu', options?: PressureObserveOptions): Promise<void>;
  disconnect(): void;
}
type PressureObserverConstructor = new (callback: (records: PressureRecord[]) => void) => PressureObserverLike;
/** The global scope, as it is where the Compute Pressure API is. */
interface PressureScope {
  PressureObserver?: PressureObserverConstructor;
}

/**
 * Watch the CPU's pressure, telling `changed` each new state; a browser without the API (Safari, Firefox) is never
 * told anything, and stays nominal. Returns the way to stop watching.
 */
export function watchPressure(changed: (state: PressureState) => void): () => void {
  // SAFETY: only reads an optional property, checked for undefined before it is used; TypeScript's DOM types do not
  // have the Compute Pressure API yet.
  const Observer = (globalThis as PressureScope).PressureObserver;
  if (Observer === undefined) return () => undefined;
  const observer = new Observer(records => {
    const last = records.at(-1);
    if (last !== undefined) changed(last.state);
  });
  observer.observe('cpu', { sampleInterval: 2_000 }).catch(() => undefined);
  return () => observer.disconnect();
}
