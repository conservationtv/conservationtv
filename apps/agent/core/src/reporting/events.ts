import type { Observable, Subscription } from 'rxjs';
import { z } from 'zod';
import type { EventData, Journal } from './journal.ts';

// The agent's system as events: each change of a key's status that says something happened, written to the journal as
// it happens (journal.ts). The system's status is live and never stored, so without these a process that died and was
// started again, or a spec that failed to apply, leaves nothing behind once it has recovered.
//
//   spec.applied / spec.failed                            a key's runtime accepted a changed spec, or threw applying one
//   process.started / process.crashed / process.stopped   a key's process, such as MediaMTX or OBS
//   runtime.error                                         a key's runtime said why something of its own failed
//
// What the agent does as it starts isn't news: each key's first accepted spec, and a process that was never running
// being stopped, say only what `agent.started` already does.

/** How far a key's spec has got, as converge reports it. */
const ApplySchema = z.object({
  state: z.string(),
  revision: z.string().nullable(),
  error: z.string().optional(),
  attempt: z.number().optional()
});
type Apply = z.output<typeof ApplySchema>;

/** What a runtime that runs a process says of it, and what any may say of its last failure: all a runtime may lack. */
const RuntimeSchema = z.object({
  state: z.string().nullable().optional().catch(undefined),
  pid: z.number().nullable().optional().catch(undefined),
  restarts: z.number().optional().catch(undefined),
  lastError: z.string().nullable().optional().catch(undefined)
});
type Runtime = z.output<typeof RuntimeSchema>;

/** Every key's status: its runtime's own, beside how far its spec has got. */
const SystemStateSchema = z.record(z.string(), z.object({ apply: ApplySchema, runtime: RuntimeSchema }));
type SystemState = z.output<typeof SystemStateSchema>;
/** One key's status. */
interface KeyState {
  apply: Apply;
  runtime: Runtime;
}

/** An event to write: its type, and what it says. */
type Event = [type: string, data: EventData];

const PROCESS_EVENTS = new Map([
  ['running', 'process.started'],
  ['crashed', 'process.crashed'],
  ['stopped', 'process.stopped']
]);

/** The event of a key's spec being accepted or refused, when that is news. */
function specEvents(key: string, now: KeyState, before: KeyState | undefined, accepted: Map<string, string | null>) {
  const { state, revision } = now.apply;
  const moved = state !== before?.apply.state || revision !== before.apply.revision;
  if (!moved) return [];
  if (state === 'failed') {
    const event: Event = ['spec.failed', { key, error: now.apply.error ?? null, attempt: now.apply.attempt ?? null }];
    return [event];
  }
  if (state !== 'applied') return [];
  // The first spec a key accepts is the one the agent started with; only a different one after it is a change.
  const first = !accepted.has(key);
  const changed = accepted.get(key) !== revision;
  accepted.set(key, revision);
  const event: Event = ['spec.applied', { key, revision }];
  return first || !changed ? [] : [event];
}

/** Whether a key's process is somewhere it wasn't: another state, or another process. */
function processMoved(now: Runtime, before: Runtime | undefined): boolean {
  // A process that was never running is `stopped` from the start, which says nothing.
  if (before === undefined) return now.state !== 'stopped';
  return now.state !== before.state || now.pid !== before.pid;
}

/** The event of a key's process starting, dying or stopping, when it did. */
function processEvents(key: string, now: KeyState, before: KeyState | undefined): Event[] {
  const type = PROCESS_EVENTS.get(now.runtime.state ?? '');
  if (type === undefined || !processMoved(now.runtime, before?.runtime)) return [];
  const { pid = null, restarts = null, lastError = null } = now.runtime;
  return [[type, { key, pid, restarts, error: lastError }]];
}

/** The event of a key's runtime saying why something failed, when it newly does; a crash says so itself. */
function errorEvents(key: string, now: KeyState, before: KeyState | undefined): Event[] {
  const error = now.runtime.lastError ?? null;
  const said = before?.runtime.lastError ?? null;
  if (error === null || error === said || now.runtime.state === 'crashed') return [];
  return [['runtime.error', { key, error }]];
}

/** Write each change of the system's status to the journal as events, until unsubscribed. */
export function journalSystem(status$: Observable<object>, journal: Journal): Subscription {
  let previous: SystemState = {};
  /** The revision each key last accepted, once it has accepted one. */
  const accepted = new Map<string, string | null>();
  return status$.subscribe({
    next: status => {
      const current = SystemStateSchema.parse(status);
      for (const [key, now] of Object.entries(current)) {
        const before = previous[key];
        const events = [
          ...specEvents(key, now, before, accepted),
          ...processEvents(key, now, before),
          ...errorEvents(key, now, before)
        ];
        for (const [type, data] of events) journal.event(type, data);
      }
      previous = current;
    },
    // The system's status errors only when a runtime's does, which the system's own stop reports.
    error: () => undefined
  });
}
