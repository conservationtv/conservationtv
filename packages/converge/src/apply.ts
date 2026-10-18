import { type Observable, catchError, concat, map, mergeMap, of, timer } from 'rxjs';
import type { z } from 'zod';
import type { Applied, Applying, Apply, ApplyFailed, Controller, Revision } from './controller.ts';
import { revisionOf } from './revision.ts';
import type { Serial } from './serial.ts';

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 300_000;

/** One key's spec as it arrives, with the revision that decides whether it changed. */
export interface Revisioned<Spec> {
  spec: Spec | undefined;
  revision: Revision;
}

export function revisioned<Spec>(spec: Spec | undefined): Revisioned<Spec> {
  if (spec === undefined) return { spec, revision: null };
  const revision = revisionOf(spec);
  return { spec, revision };
}

/** Announces `applying`, then runs the key's execute (or finalize) through `queue`, retrying with backoff. */
export function apply<Spec extends z.ZodType, Status>(
  controller: Controller<Spec, Status>,
  current: Revisioned<z.output<Spec>>,
  queue: Serial
): Observable<Apply> {
  const run = () => queue(signal => settle(controller, current.spec, signal));
  const applying: Applying = { state: 'applying', revision: current.revision };
  const announced = of(applying);
  const attempts = attempt(run, current.revision, 1);
  return concat(announced, attempts);
}

function settle<Spec extends z.ZodType, Status>(
  controller: Controller<Spec, Status>,
  spec: z.output<Spec> | undefined,
  signal: AbortSignal
): Promise<void> {
  if (spec !== undefined) return controller.execute(spec, signal);
  if (controller.finalize === undefined) return Promise.resolve();
  return controller.finalize(signal);
}

function attempt(run: () => Observable<void>, revision: Revision, count: number): Observable<Apply> {
  const applied: Applied = { state: 'applied', revision };
  const retry = (cause: unknown): Observable<Apply> => {
    const failed: ApplyFailed = { state: 'failed', revision, error: describe(cause), attempt: count };
    const reported = of(failed);
    const delay = Math.min(RETRY_BASE_MS * 2 ** (count - 1), RETRY_MAX_MS);
    const wait = timer(delay);
    const again = mergeMap(() => attempt(run, revision, count + 1));
    const retried = wait.pipe(again);
    return concat(reported, retried);
  };
  const toApplied = map<void, Apply>(() => applied);
  const retryAfterBackoff = catchError<Apply, Observable<Apply>>(retry);
  const attempted = run();
  return attempted.pipe(toApplied, retryAfterBackoff);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
