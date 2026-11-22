import type {
  CameraAxis,
  CameraCapabilities,
  CameraOptionValues,
  CameraPosition,
  Drive,
  MoveBy,
  MoveTo,
  MoveToPoint,
  MoveToRegion
} from '../contract.ts';

// What a driver does for one camera: the contract's commands (../contract.ts), in the contract's units, translated to
// whatever the camera speaks. A driver holds no session and decides nothing about who may move the camera: the agent
// does both, above it (apps/agent/core/src/cameras). Every call gives up at `signal`.

/** One camera, as its driver reaches it. */
export interface CameraDriver {
  /** What the camera can do, asked of the camera itself. */
  capabilities: (signal: AbortSignal) => Promise<CameraCapabilities>;
  /** Where it points now, on the axes it reports. */
  position: (signal: AbortSignal) => Promise<CameraPosition>;
  /** What each of its options is set to now. */
  options: (signal: AbortSignal) => Promise<CameraOptionValues>;
  moveTo: (target: Omit<MoveTo, 'kind'>, signal: AbortSignal) => Promise<void>;
  moveBy: (offset: Omit<MoveBy, 'kind'>, signal: AbortSignal) => Promise<void>;
  moveToPoint: (point: Omit<MoveToPoint, 'kind'>, signal: AbortSignal) => Promise<void>;
  moveToRegion: (region: Omit<MoveToRegion, 'kind'>, signal: AbortSignal) => Promise<void>;
  /**
   * Keep moving at these velocities until told otherwise, on the axes named and no others: an axis left out keeps doing
   * whatever it was, such as a move to a place. The agent names only the axes moving, or being stopped, and stops the
   * camera when its driver goes quiet.
   */
  drive: (velocity: Omit<Drive, 'kind'>, signal: AbortSignal) => Promise<void>;
  /**
   * Stop moving on these axes, whether driven or moving to a place. Stopping focus takes the camera off focusing itself,
   * so the agent names it only when it drove focus.
   */
  stop: (axes: readonly CameraAxis[], signal: AbortSignal) => Promise<void>;
  configure: (key: string, value: string, signal: AbortSignal) => Promise<void>;
  run: (action: string, signal: AbortSignal) => Promise<void>;
}

/** A command the camera's driver has no way to carry out: the camera's capabilities never offered it. */
export class UnsupportedCommand extends Error {
  constructor(what: string) {
    super(`The camera cannot ${what}`);
    this.name = 'UnsupportedCommand';
  }
}

/** A camera that did not do what it was asked: unreachable, or it refused. */
export class CameraFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CameraFailure';
  }
}
