import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Apply } from '../src/index.ts';
import { FakeRuntime, app, flush, revisionFor, succeedAfter, until, started } from './harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

/** A splat over one hand-driven `web` runtime, past its boot-time finalize. */
async function booted(web: FakeRuntime) {
  const system = await started({ resolvers: { web: web.resolver } });
  const boot = await web.next();
  boot.succeed();
  return system;
}

describe('specs arriving faster than they apply', () => {
  // Web is told to run v1. The runtime is slow, and it ignores aborts, so it keeps going. While it works, someone
  // sets v2 and then v3. Splat aborts v1, but has to wait for it to finish. When it does, v2 is already out of date,
  // so splat skips it and goes straight to v3. The runtime only ever sees v1 then v3, one at a time.
  it('skips the specs that arrive while an apply is busy: only the latest runs after it', async () => {
    const web = new FakeRuntime(false);
    const system = await booted(web);

    await system.set('web', app(1));
    const first = await web.next();
    await system.set('web', app(2));
    await system.set('web', app(3));

    expect(first.signal.aborted).toBe(true);
    first.succeed();
    const latest = await web.next();
    expect(latest.spec).toEqual(app(3));
    latest.succeed();

    await until(system, s => s.web.apply.state === 'applied');
    expect(web.history).toEqual([undefined, 1, 3]);
    expect(web.maxInFlight).toBe(1);
    system.stop();
  });

  // Web is told to run v1, and while the runtime works on it, someone sets v2. Splat aborts v1, but this runtime
  // ignores the abort and finishes v1 anyway. Splat doesn't start v2 until v1 is done, so v2 always lands last and
  // wins. And although the runtime did briefly run v1, the status never says v1 was applied: by the time it
  // finished, nobody wanted it any more.
  it('waits for a runtime that ignores the abort, so a superseded apply can never land after the latest', async () => {
    const web = new FakeRuntime(false);
    const system = await booted(web);
    const applies: Apply[] = [];
    const recording = system.status$.subscribe(s => applies.push(s.web.apply));

    await system.set('web', app(1));
    const stale = await web.next();
    await system.set('web', app(2));
    await flush();

    // The stale apply is still running, so the newer one has not started alongside it.
    expect(stale.signal.aborted).toBe(true);
    expect(web.waiting).toBe(0);

    stale.succeed();
    const latest = await web.next();
    expect(latest.spec).toEqual(app(2));
    latest.succeed();
    await until(system, s => s.web.apply.state === 'applied' && s.web.apply.revision === revisionFor(app(2)));

    // Splat never claimed the stale spec was applied, even though the runtime briefly ran it.
    expect(applies).not.toContainEqual({ state: 'applied', revision: revisionFor(app(1)) });
    expect(web.maxInFlight).toBe(1);
    recording.unsubscribe();
    system.stop();
  });

  // Web is told to run v1, and while the runtime is still working on it, someone removes web. Splat doesn't start
  // tearing web down until the v1 apply has finished, so the two never run at once. Then it finalizes web, and the
  // status reports the removal as applied.
  it('finalizes a key removed mid-apply only once the apply has settled', async () => {
    const web = new FakeRuntime(false);
    const system = await booted(web);

    await system.set('web', app(1));
    const executing = await web.next();
    await system.remove('web');
    await flush();
    expect(web.waiting).toBe(0);

    executing.succeed();
    const finalize = await web.next();
    expect(finalize.kind).toBe('finalize');
    finalize.succeed();

    const status = await until(system, s => s.web.apply.state === 'applied' && s.web.apply.revision === null);
    expect(status.web.runtime.spec).toBeUndefined();
    system.stop();
  });
});

describe('concurrent mutations', () => {
  // Five callers change the spec at the same moment: two set web, two set db, one removes db. Each change is saved
  // in turn, with no two saves at once, and each one builds on the spec the change before it left. So nothing gets
  // overwritten with an out-of-date copy. The end result is what you would get by making the changes one after
  // another: web at v2 and db at v9.
  it('keeps every one, in the order they were made, even when they all land in the same tick', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const db = new FakeRuntime(true, succeedAfter(0));
    const persisted: string[] = [];
    let writing = 0;
    let overlapped = false;
    const sink = async () => {
      writing++;
      overlapped ||= writing > 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      persisted.push('write');
      writing--;
    };
    const system = await started({ resolvers: { web: web.resolver, db: db.resolver }, sink });

    // Each mutation reads the spec as the one before left it: none overwrites another with a stale copy.
    await Promise.all([
      system.set('web', app(1)),
      system.set('db', app(1)),
      system.set('web', app(2)),
      system.remove('db'),
      system.set('db', app(9))
    ]);

    const status = await until(
      system,
      s =>
        s.web.apply.revision === revisionFor(app(2)) &&
        s.db.apply.revision === revisionFor(app(9)) &&
        s.web.apply.state === 'applied' &&
        s.db.apply.state === 'applied'
    );
    expect(status.web.runtime.spec).toEqual(app(2));
    expect(status.db.runtime.spec).toEqual(app(9));
    expect(persisted).toHaveLength(5);
    expect(overlapped).toBe(false);
    system.stop();
  });

  // Web is running v1. Someone sets web to v1 again, writing the fields in a different order. Splat sees it is the
  // same spec and doesn't bother the runtime. Then someone changes db. That only touches db; web is left alone.
  it('does not re-apply a spec that is the same, however its fields are ordered', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const db = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ resolvers: { web: web.resolver, db: db.resolver } });
    await system.replace({ web: { image: 'app', version: 1 }, db: app(1) });
    await until(system, s => s.web.apply.state === 'applied' && s.db.apply.revision === revisionFor(app(1)));
    const before = web.calls.length;

    await system.set('web', { version: 1, image: 'app' });
    // Changing another key leaves this one alone.
    await system.set('db', app(2));
    await until(system, s => s.db.apply.state === 'applied' && s.db.apply.revision === revisionFor(app(2)));

    expect(web.calls).toHaveLength(before);
    system.stop();
  });
});

describe('keys are independent', () => {
  // Two keys, slow and fast. Slow's runtime gets stuck and never finishes anything. Both are set to v1. Fast still
  // gets v1 applied while slow is stuck, because each key waits only for its own runtime.
  it('a key stuck applying does not hold up the others', async () => {
    const slow = new FakeRuntime();
    const fast = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ resolvers: { slow: slow.resolver, fast: fast.resolver } });

    await system.replace({ slow: app(1), fast: app(1) });
    const status = await until(system, s => s.fast.apply.state === 'applied' && s.fast.apply.revision !== null);

    // `slow` has not even finished its boot-time finalize.
    expect(status.slow.apply.state).toBe('applying');
    expect(status.fast.runtime.spec).toEqual(app(1));
    system.stop();
  });
});

describe('failures', () => {
  // Web is told to run v1, but the image pull fails. The status reports the failure as attempt 1. Splat waits one
  // second and tries again. It fails again, so the status shows attempt 2, and splat waits two seconds this time.
  // The third try works, and the status says v1 is applied.
  it('retries with a growing backoff, reporting each failure, until the runtime accepts', async () => {
    vi.useFakeTimers();
    const web = new FakeRuntime();
    const system = await booted(web);
    await system.set('web', app(1));

    const first = await web.next();
    first.fail('image pull failed');
    const failed = await until(system, s => s.web.apply.state === 'failed');
    expect(failed.web.apply).toMatchObject({ state: 'failed', error: 'image pull failed', attempt: 1 });

    await vi.advanceTimersByTimeAsync(999);
    expect(web.waiting).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const second = await web.next();
    second.fail('image pull failed');
    await until(system, s => s.web.apply.state === 'failed' && s.web.apply.attempt === 2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(web.waiting).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const third = await web.next();
    third.succeed();

    const status = await until(system, s => s.web.apply.state === 'applied');
    expect(status.web.runtime.spec).toEqual(app(1));
    system.stop();
  });

  // Web is told to run v1, but the config is bad and it fails. Splat schedules a retry for a second later. Before
  // that, someone fixes the config and sets v2. Splat doesn't wait out the backoff: it runs v2 straight away. The
  // retry of v1 is cancelled, so even an hour later the runtime has never been asked for v1 again.
  it('a newer spec cuts a backoff short instead of waiting it out', async () => {
    vi.useFakeTimers();
    const web = new FakeRuntime();
    const system = await booted(web);
    await system.set('web', app(1));
    const broken = await web.next();
    broken.fail('bad config');
    await until(system, s => s.web.apply.state === 'failed');

    await system.set('web', app(2));
    const fixed = await web.next();

    expect(fixed.spec).toEqual(app(2));
    fixed.succeed();
    // The retry of the broken spec was cancelled, not just delayed.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(web.history).toEqual([undefined, 1, 2]);
    system.stop();
  });
});
