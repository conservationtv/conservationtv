import type { Observable } from 'rxjs';
import type { z } from 'zod';

/** A stable hash of one key's spec. `null` while the key is absent. */
export type Revision = string | null;

/**
 * One top-level key: the schema its spec is parsed with, and the runtime that converges to it. The runtime owns its
 * status; splat only tells it what the spec is now.
 */
export interface Resolver<Spec extends z.ZodType, Status> {
  spec: Spec;
  /** The runtime's live status. Hot, with a current value: nothing reports until every key has one. */
  status: Observable<Status>;
  /**
   * Converge to `spec`. Splat runs one call per key at a time, always with the latest spec, so resolve once the
   * runtime has accepted the spec and let long work carry on, reporting through `status`. `signal` aborts when a
   * newer spec supersedes this one or splat stops.
   */
  execute(spec: z.output<Spec>, signal: AbortSignal): Promise<void>;
  /** The key is absent: removed, or missing at boot. Called when there may be nothing to remove. */
  finalize?(signal: AbortSignal): Promise<void>;
  /**
   * Splat has stopped: release what the runtime holds, such as timers. Not a removal, so the runtime is left doing
   * what it was doing. Called once nothing more will be applied.
   */
  dispose?(): void;
}

/** Infers the spec schema and the status type so `execute` and `status` are checked against them. */
export function resolver<Spec extends z.ZodType, Status>(definition: Resolver<Spec, Status>): Resolver<Spec, Status> {
  return definition;
}

export type Resolvers = Record<string, Resolver<z.ZodType, unknown>>;

/** The status a resolver's runtime reports. */
export type StatusOf<Owner> = Owner extends Resolver<z.ZodType, infer Status> ? Status : never;

/** The whole system's desired state: each resolver's key, present or absent. */
export type SystemSpec<R extends Resolvers> = { [K in keyof R]?: z.output<R[K]['spec']> };

/** Every key's live status, beside how far splat has got applying its spec. */
export type SystemStatus<R extends Resolvers> = { [K in keyof R]: KeyStatus<StatusOf<R[K]>> };

export interface KeyStatus<Status> {
  runtime: Status;
  apply: Apply;
}

/** Splat's side of a key's status: whether the runtime has accepted the latest spec. */
export type Apply = Applying | Applied | ApplyFailed;

export interface Applying {
  state: 'applying';
  revision: Revision;
}

/** The runtime accepted `revision`; a `null` revision means the key was finalized. */
export interface Applied {
  state: 'applied';
  revision: Revision;
}

/** The last attempt threw; another follows after a backoff unless a newer spec arrives first. */
export interface ApplyFailed {
  state: 'failed';
  revision: Revision;
  error: string;
  attempt: number;
}
