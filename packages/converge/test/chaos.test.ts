import { BehaviorSubject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Controller,
  type Convergence,
  type Mutations,
  type Mutator,
  type SystemSpec,
  controller,
  converge
} from '../src/index.ts';
import { type AppSpec, AppSpecSchema, type Running, app, revisionFor, seeded } from './harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

const KEYS = ['web', 'db', 'cache'] as const;
type Key = (typeof KEYS)[number];
type Chaos = Record<Key, Controller<typeof AppSpecSchema, Running>>;
const SEEDS = Array.from({ length: Number(process.env.CHAOS_SEEDS ?? 60) }, (_, index) => index + 1);
const LIVES = 5;
const OPERATIONS = 15;

/** One process's lifetime: from starting converge until it stops, or is killed. */
interface Life {
  id: number;
  /** `stop()` has resolved (or the start failed): nothing may happen in this life's name any more. */
  stopped: boolean;
  /** The process died: whatever it was doing simply never finishes. */
  killed: boolean;
  /** How to end each call this life still has open, should the process die under it. */
  open: Set<() => void>;
  /** Each runtime's status stream, so the test can break one. */
  statuses: Map<Key, BehaviorSubject<Running>>;
}

/** A change the test made, and whether it has settled yet. */
interface Change {
  life: Life;
  settled: boolean;
}

/**
 * What is really out there, outliving any one process: what each key is running, how many calls are working on it
 * right now, and every promise the system broke along the way.
 */
class World {
  readonly running = new Map<Key, AppSpec | undefined>();
  readonly violations: string[] = [];
  private readonly inFlight = new Map<Key, number>();

  enter(key: Key, life: Life): void {
    if (life.stopped) this.violations.push(`life ${life.id} called ${key} after it stopped`);
    const count = (this.inFlight.get(key) ?? 0) + 1;
    this.inFlight.set(key, count);
    if (count > 1) this.violations.push(`${key} had ${count} calls at once`);
  }

  leave(key: Key): void {
    this.inFlight.set(key, (this.inFlight.get(key) ?? 1) - 1);
  }

  busy(key: Key): boolean {
    return (this.inFlight.get(key) ?? 0) > 0;
  }
}

/** A promise that never settles: what a dead process's work turns into. */
function never(): Promise<void> {
  return new Promise(() => undefined);
}

/**
 * A runtime that misbehaves at random: it throws before returning, rejects later, takes its time (sometimes seconds),
 * may ignore aborts and carry on regardless, may have its status stream break, and may throw when disposed.
 */
function chaotic(world: World, key: Key, life: Life, next: () => number): Chaos[Key] {
  const ignoresAbort = next() < 0.3;
  const throwsOnDispose = next() < 0.1;
  const status = new BehaviorSubject<Running>({ spec: world.running.get(key) });
  life.statuses.set(key, status);
  // Each call rolls for how it goes: a dead process never answers, some calls throw at once, some reject later, and
  // the rest succeed after a delay, unless an abort cuts them short.
  const call = (spec: AppSpec | undefined, signal: AbortSignal): Promise<void> => {
    if (life.killed) return never();
    if (spec !== undefined && !AppSpecSchema.safeParse(spec).success)
      world.violations.push(`${key} was sent an invalid spec`);
    world.enter(key, life);
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      life.open.delete(leave);
      world.leave(key);
    };
    life.open.add(leave);
    const roll = next();
    if (roll < 0.1) {
      leave();
      throw new Error('threw before returning');
    }
    const fails = roll < 0.35;
    const latency = next() < 0.1 ? 5_000 : Math.floor(next() * 30);
    return new Promise((resolve, reject) => {
      const finish = (error: Error | undefined): void => {
        if (left || life.killed) return;
        leave();
        if (error === undefined) resolve();
        else reject(error);
      };
      const timeout = setTimeout(() => {
        if (life.killed) return;
        if (fails) return finish(new Error('rejected later'));
        world.running.set(key, spec);
        status.next({ spec });
        finish(undefined);
      }, latency);
      if (ignoresAbort) return;
      const abort = (): void => {
        clearTimeout(timeout);
        finish(new Error('aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  return controller({
    spec: AppSpecSchema,
    status,
    execute: (spec, signal) => call(spec, signal),
    finalize: signal => call(undefined, signal),
    dispose: () => {
      if (world.busy(key)) world.violations.push(`life ${life.id} disposed ${key} while a call was still running`);
      if (throwsOnDispose) throw new Error('dispose failed');
    }
  });
}

/** Waits for `promise`, letting time pass meanwhile. It must settle within a simulated hour. */
async function withTime<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  promise.then(mark, mark);
  for (let waited = 0; !settled && waited < 60 * 60 * 1000; waited += 100) await vi.advanceTimersByTimeAsync(100);
  if (!settled) throw new Error('Never settled');
  return promise;
}

/** Stops a system. A cleanup that throws still stops it, so that rejection is expected here. */
async function stop(system: Convergence<Chaos>): Promise<void> {
  try {
    await withTime(system.stop());
  } catch (error) {
    if (!(error instanceof AggregateError)) throw error;
  }
}

/** One seeded run: the world it acts on, what storage holds, and every change made along the way. */
class Run {
  readonly world = new World();
  readonly changes: Change[] = [];
  saved: SystemSpec<Chaos> = {};

  constructor(readonly next: () => number) {}

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Keeps an eye on a change, to check later that it settled. */
  track(life: Life, promise: Promise<void>): void {
    const change: Change = { life, settled: false };
    this.changes.push(change);
    const mark = (): void => {
      change.settled = true;
    };
    promise.then(mark, mark);
  }
}

/** A life that got going: its system, the API's hands on the spec, and how to stop the looping mutator. */
interface Started {
  system: Convergence<Chaos>;
  api: Mutations<Chaos>;
  quiet(): void;
}

describe('chaos', () => {
  // Each seed is a run of several lives of the same system. Some lives end with a clean stop. Others are killed: the
  // process dies, and whatever it was in the middle of simply never finishes. Some never get going, because storage
  // can't be read or a mutator throws while starting.
  //
  // Every part misbehaves. Runtimes throw, reject, dawdle, ignore aborts, break their status streams and throw when
  // disposed. The disk fails a fifth of its writes, and is sometimes slow. One mutator makes random changes, some of
  // them invalid. Another loops, flipping a key between two specs. A rogue one makes a change the moment it is
  // handed the changes, and ignores its cleanup, carrying on after the system stops. Between changes, time passes at
  // random.
  //
  // Whatever happens: nothing runs twice at once, nothing touches the world or storage after its life has stopped,
  // nothing goes unhandled, and every change in a life that wasn't killed settles one way or the other. When the last
  // life is left alone, every runtime ends up running exactly what storage says, and reports it applied.
  it.each(SEEDS)('seed %i: survives kills, interruptions, failures and misbehaving mutators', async seed => {
    vi.useFakeTimers();
    const run = new Run(seeded(seed));

    for (let id = 1; id < LIVES; id++) await live(run, id);
    await judge(run, LIVES);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(run.world.violations).toEqual([]);
    const unsettled = run.changes.filter(change => !change.life.killed && !change.settled);
    expect(unsettled).toEqual([]);
  });
});

/** Starts a life, or fails to: storage may be unreadable, or a mutator may throw while starting. */
async function start(run: Run, life: Life, last: boolean): Promise<Started | undefined> {
  const { world, next } = run;
  const controllers = {
    web: chaotic(world, 'web', life, next),
    db: chaotic(world, 'db', life, next),
    cache: chaotic(world, 'cache', life, next)
  };
  const unreadable = !last && next() < 0.1;
  const restore = async (): Promise<SystemSpec<Chaos>> => {
    if (unreadable) throw new Error('disk unreadable');
    return run.saved;
  };
  // A dead process never finishes a write. Otherwise the disk takes its time, then fails or saves.
  const sink = async (spec: SystemSpec<Chaos>): Promise<void> => {
    if (life.killed) return never();
    const latency = next() < 0.1 ? 5_000 : Math.floor(next() * 20);
    await new Promise(resolve => setTimeout(resolve, latency));
    if (life.killed) return never();
    if (life.stopped) world.violations.push(`life ${life.id} persisted after it stopped`);
    const unknown = Object.keys(spec).filter(key => !KEYS.some(known => known === key));
    if (unknown.length > 0) world.violations.push(`life ${life.id} persisted unknown keys ${unknown}`);
    if (next() < 0.2) throw new Error('disk full');
    run.saved = spec;
  };

  const handed: Mutations<Chaos>[] = [];
  const api: Mutator<Chaos> = given => {
    handed.push(given);
    return () => undefined;
  };
  let looping = true;
  const loop: Mutator<Chaos> = given => {
    const spin = async (): Promise<void> => {
      for (let turn = 0; looping; turn++) {
        await given.set('cache', app(7 + (turn % 2))).catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 3));
      }
    };
    void spin();
    return () => {
      looping = false;
    };
  };
  const rogue: Mutator<Chaos> = given => {
    const strike = (): void => {
      run.track(life, given.set('db', app(Math.floor(next() * 4))));
      if (next() < 0.8) setTimeout(strike, Math.floor(next() * 200));
    };
    strike();
    return () => undefined;
  };
  const broken: Mutator<Chaos> = () => {
    throw new Error('mutator failed to start');
  };
  const mutators = !last && next() < 0.1 ? [api, loop, rogue, broken] : [api, loop, rogue];
  const quiet = (): void => {
    looping = false;
  };

  const system = await withTime(converge({ controllers, sink, restore, mutators })).catch(() => undefined);
  const given = handed[0];
  if (system === undefined || given === undefined) {
    quiet();
    return undefined;
  }
  return { system, api: given, quiet };
}

/** Makes random changes through the API, letting time pass between some of them. */
async function change(run: Run, life: Life, api: Mutations<Chaos>, operations: number): Promise<void> {
  for (let operation = 0; operation < operations; operation++) {
    const key = run.pick(KEYS);
    run.track(life, randomChange(api, key, run.next));
    if (run.next() < 0.5) await vi.advanceTimersByTimeAsync(Math.floor(run.next() * 40));
  }
}

/** One interrupted life: it starts (or doesn't), takes changes, and then stops or is killed part-way through. */
async function live(run: Run, id: number): Promise<void> {
  const life: Life = { id, stopped: false, killed: false, open: new Set(), statuses: new Map() };
  const started = await start(run, life, false);
  if (started === undefined) {
    // It never got going, and must have left nothing running.
    life.stopped = true;
    return;
  }
  // A runtime's status stream breaks part-way through the life.
  if (run.next() < 0.2) {
    const key = run.pick(KEYS);
    setTimeout(() => life.statuses.get(key)?.error(new Error('status broke')), Math.floor(run.next() * 100));
  }
  await change(run, life, started.api, Math.floor(run.next() * OPERATIONS));
  await vi.advanceTimersByTimeAsync(Math.floor(run.next() * 50));
  started.quiet();
  if (run.next() < 0.4) {
    // Killed, part-way through whatever it was doing: nothing it had open ever finishes.
    life.killed = true;
    for (const leave of life.open) leave();
    return;
  }
  await stop(started.system);
  life.stopped = true;
}

/** The last life: it takes its changes, is left alone long enough for every retry to succeed, and is judged. */
async function judge(run: Run, id: number): Promise<void> {
  const life: Life = { id, stopped: false, killed: false, open: new Set(), statuses: new Map() };
  const started = await start(run, life, true);
  if (started === undefined) throw new Error('The last life failed to start');
  const { system } = started;
  await change(run, life, started.api, OPERATIONS);
  started.quiet();
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

  const status = await system.status();
  expect(run.world.violations).toEqual([]);
  expect(system.spec()).toEqual(run.saved);
  for (const key of KEYS) {
    expect(run.world.running.get(key), `${key} runs what storage says`).toEqual(run.saved[key]);
    expect(status[key].apply, `${key} reports it applied`).toEqual({
      state: 'applied',
      revision: revisionFor(run.saved[key])
    });
  }
  await stop(system);
  life.stopped = true;
}

/** A change through the API: mostly sets and removes, now and then a whole replace, or something invalid. */
function randomChange(api: Mutations<Chaos>, key: Key, next: () => number): Promise<void> {
  const roll = next();
  const version = Math.floor(next() * 4);
  if (roll < 0.55) return api.set(key, app(version));
  if (roll < 0.75) return api.remove(key);
  if (roll < 0.85) return api.replace({ web: app(version) });
  if (roll < 0.93) return api.set(key, { image: 'app', version: 1.5 });
  return api.replace(withGhost());
}

/** A spec with a key no controller owns, as a careless caller might send. */
function withGhost(): SystemSpec<Chaos> {
  const spec = { web: app(1), ghost: app(1) };
  return spec;
}
