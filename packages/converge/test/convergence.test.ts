import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SystemSpec } from '../src/index.ts';
import { type Driver, FakeRuntime, app, revisionFor, until, started } from './harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

const KEYS = ['web', 'db', 'cache'] as const;
const SEEDS = Array.from({ length: 40 }, (_, index) => index + 1);
const OPERATIONS = 30;

/** mulberry32: a small seeded generator, so a failing seed replays exactly. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each call takes up to 50ms, and a third of them fail. */
function unreliable(next: () => number): Driver {
  return call => {
    const latency = Math.floor(next() * 50);
    const fails = next() < 1 / 3;
    setTimeout(() => (fails ? call.fail('flaky') : call.succeed()), latency);
  };
}

type Controllers = Record<(typeof KEYS)[number], FakeRuntime['controller']>;

describe('eventual consistency', () => {
  // Three keys, each with an unreliable runtime: calls take a random time, a third of them fail, and some runtimes
  // ignore aborts. Thirty random changes are thrown at the system, sometimes several at once, sometimes with a pause
  // between. Alongside, the test works out where things should end up by making the same changes one after another.
  // Then it lets time run until every retry has had its chance. However the run went, each runtime must end up
  // running exactly what the test expects, the status must say so, and no runtime ever had two calls at once. Each
  // seed replays the same run exactly, so a failure can be reproduced.
  it.each(SEEDS)(
    'seed %i: under random mutations, latencies and failures, every runtime ends up running the final spec',
    async seed => {
      vi.useFakeTimers();
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
      // Some runtimes give up when superseded; others finish the stale work first.
      const runtimes = {
        web: new FakeRuntime(next() < 0.5, unreliable(next)),
        db: new FakeRuntime(next() < 0.5, unreliable(next)),
        cache: new FakeRuntime(next() < 0.5, unreliable(next))
      };
      const controllers = {
        web: runtimes.web.controller,
        db: runtimes.db.controller,
        cache: runtimes.cache.controller
      };
      const system = await started({ controllers });

      // The model: mutations apply in the order they are made, so the desired state is them applied in turn.
      let desired: SystemSpec<Controllers> = {};
      const mutations: Promise<void>[] = [];
      for (let operation = 0; operation < OPERATIONS; operation++) {
        const key = pick(KEYS);
        const roll = next();
        if (roll < 0.6) {
          const spec = app(Math.floor(next() * 4));
          desired = { ...desired, [key]: spec };
          mutations.push(system.set(key, spec));
        } else if (roll < 0.85) {
          const { [key]: _removed, ...rest } = desired;
          desired = rest;
          mutations.push(system.remove(key));
        } else {
          const spec = Object.fromEntries(KEYS.filter(() => next() < 0.5).map(k => [k, app(Math.floor(next() * 4))]));
          desired = spec;
          mutations.push(system.replace(spec));
        }
        // Sometimes several mutations land at once; sometimes runtimes get a moment to start applying.
        if (next() < 0.5) await vi.advanceTimersByTimeAsync(Math.floor(next() * 40));
      }
      await Promise.all(mutations);

      const goal = desired;
      const converged = until(system, status =>
        KEYS.every(
          key => status[key].apply.state === 'applied' && status[key].apply.revision === revisionFor(goal[key])
        )
      );
      // Long enough for any sequence of failures to have been retried to success.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      const status = await converged;

      for (const key of KEYS) {
        const runtime = runtimes[key];
        expect(runtime.running.getValue().spec, `${key} runs the final spec`).toEqual(goal[key]);
        expect(status[key].runtime.spec, `${key} reports what it runs`).toEqual(goal[key]);
        expect(status[key].apply, `${key} reports the final spec applied`).toEqual({
          state: 'applied',
          revision: revisionFor(goal[key])
        });
        expect(runtime.maxInFlight, `${key} never applied twice at once`).toBe(1);
      }
      system.stop();
    }
  );
});
