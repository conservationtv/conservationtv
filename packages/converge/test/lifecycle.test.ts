import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotMutating, controller, type MutatorRun, type SystemSpec } from '../src/index.ts';
import { AppSpecSchema, FakeRuntime, app, flush, revisionFor, succeedAfter, until, started } from './harness.ts';

/** A system of one `web` runtime. */
type WebOnly = Record<'web', FakeRuntime['controller']>;

/** A system of a `web` and a `db` runtime. */
type Pair = Record<'web' | 'db', FakeRuntime['controller']>;

afterEach(() => {
  vi.useRealTimers();
});

describe('starting', () => {
  // The system starts with nothing stored, so the web key has no spec. The system can't tell whether web was never
  // configured or was removed while the system was down, so it asks the runtime to finalize. Once the runtime
  // does, the status reports the removal as applied, with no revision.
  it('finalizes a key that is absent at boot, so something removed while the system was down is still torn down', async () => {
    const web = new FakeRuntime();
    const system = await started({ controllers: { web: web.controller } });

    const call = await web.next();
    expect(call.kind).toBe('finalize');
    call.succeed();

    const status = await until(system, s => s.web.apply.state === 'applied');
    expect(status.web.apply.revision).toBeNull();
    system.stop();
  });

  // The system restarts and finds web at v3 in storage. Before anything else happens, the runtime is asked to run v3:
  // whatever was there before the restart is picked straight back up.
  it('resumes the restored spec before any mutation arrives', async () => {
    const web = new FakeRuntime();
    const system = await started({ controllers: { web: web.controller }, restore: async () => ({ web: app(3) }) });

    const call = await web.next();
    expect(call.kind).toBe('execute');
    expect(call.spec).toEqual(app(3));
    system.stop();
  });

  // This is how the agent starts. Its spec is fixed in code and handed over as the spec to start from, so the very
  // first thing the runtime is asked to do is run it. There is no finalize to start and then abort, as there would
  // be if the spec arrived as a change just after starting.
  it("boots the agent's way: a spec fixed in code is the first thing the runtime runs", async () => {
    const web = new FakeRuntime();
    const system = await started({ controllers: { web: web.controller }, restore: async () => ({ web: app(1) }) });

    const execute = await web.next();
    expect(execute.kind).toBe('execute');
    expect(execute.spec).toEqual(app(1));
    execute.succeed();
    await until(system, s => s.web.apply.state === 'applied' && s.web.apply.revision === revisionFor(app(1)));
    expect(web.history).toEqual([1]);
    system.stop();
  });

  // Two runtimes: web reports a status straight away, but quiet says nothing. Someone asks for the system's status
  // and is left waiting, because the system only reports once it can say something about every key. As soon as quiet
  // reports that it is up, the waiting reader gets an answer that includes it.
  it('reports nothing at all until every runtime has reported a status of its own', async () => {
    const silent = new Subject<string>();
    const quiet = controller({ spec: AppSpecSchema, status: silent, execute: async () => undefined });
    const web = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ controllers: { web: web.controller, quiet } });

    const first = firstValueFrom(system.status$);
    let reported = false;
    void first.then(() => {
      reported = true;
    });
    await flush();
    // A reader of the status (such as GET /system) waits here for as long as any runtime stays silent.
    expect(reported).toBe(false);

    silent.next('up');
    const status = await first;
    expect(status.quiet.runtime).toBe('up');
    system.stop();
  });
});

describe('mutators', () => {
  // The mutator sets web as soon as it starts, and a caller then uses its context from outside to set db
  // and move web on to v2. Both feed the same queue, so the changes land in the order they were made, and both keys
  // end up where the last change left them.
  it('takes changes from its run and from outside it through one queue, in the order they are made', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const db = new FakeRuntime(true, succeedAfter(0));
    const source: MutatorRun<Pair> = context => {
      void context.update(draft => {
        draft.web = app(1);
      });
    };
    const system = await started({ controllers: { web: web.controller, db: db.controller }, mutator: source });

    await system.set('db', app(1));
    await system.set('web', app(2));
    await until(
      system,
      s =>
        s.web.apply.state === 'applied' &&
        s.web.apply.revision === revisionFor(app(2)) &&
        s.db.apply.state === 'applied' &&
        s.db.apply.revision === revisionFor(app(1))
    );

    expect(web.running.getValue().spec).toEqual(app(2));
    expect(db.running.getValue().spec).toEqual(app(1));
    system.stop();
  });
});

describe('persisting', () => {
  // Someone sets web to v1. The system writes it to storage first, and only then asks the runtime to run it. So if the
  // process dies between the two, storage already knows about v1 and the restart will apply it. The runtime is never
  // running something that storage has never heard of.
  it('persists a spec before applying it, so the runtime is never ahead of storage', async () => {
    const events: string[] = [];
    const web = new FakeRuntime(true, call => {
      events.push(`${call.kind} ${call.spec?.version}`);
      call.succeed();
    });
    const sink = async (spec: SystemSpec<WebOnly>) => {
      events.push(`sink ${spec.web?.version}`);
    };
    const system = await started({ controllers: { web: web.controller }, sink });

    await system.set('web', app(1));
    await until(system, s => s.web.apply.revision === revisionFor(app(1)) && s.web.apply.state === 'applied');

    expect(events).toEqual(['finalize undefined', 'sink 1', 'execute 1']);
    system.stop();
  });

  // Someone sets web to v1, and it is saved and applied. Then they set v2, but the disk is full and saving fails.
  // That set() call rejects, and the system behaves as if it never happened: the desired spec is still v1, and the
  // runtime never sees v2. Then they set v3, which saves fine and is applied. One failed write doesn't jam the ones
  // after it.
  it('rejects a mutation whose sink fails, leaving the desired state as it was, and carries on', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const sink = async (spec: SystemSpec<WebOnly>) => {
      if (spec.web?.version === 2) throw new Error('disk full');
    };
    const system = await started({ controllers: { web: web.controller }, sink });

    await system.set('web', app(1));
    await expect(system.set('web', app(2))).rejects.toThrow('disk full');
    await system.set('web', app(3));
    await until(system, s => s.web.apply.revision === revisionFor(app(3)) && s.web.apply.state === 'applied');

    expect(web.history).not.toContain(2);
    expect(web.running.getValue().spec).toEqual(app(3));
    system.stop();
  });

  // The first convergence is told to run web at v5. It saves v5, applies it, and reports a revision. Then it
  // stops, as if the process were restarting. A second convergence starts with a brand-new runtime, reads v5 back
  // from storage, and applies it without anyone asking. It reports exactly the same revision as before the
  // restart.
  it('a restart resumes from storage and reports the same revision, without any mutation', async () => {
    let stored: SystemSpec<WebOnly> = {};
    const sink = async (spec: typeof stored) => {
      stored = spec;
    };
    const restore = async () => stored;

    const before = new FakeRuntime(true, succeedAfter(0));
    const first = await started({ controllers: { web: before.controller }, sink, restore });
    await first.set('web', app(5));
    const converged = await until(
      first,
      s => s.web.apply.revision === revisionFor(app(5)) && s.web.apply.state === 'applied'
    );
    first.stop();

    const after = new FakeRuntime(true, succeedAfter(0));
    const second = await started({ controllers: { web: after.controller }, sink, restore });
    const resumed = await until(second, s => s.web.apply.state === 'applied');

    expect(resumed.web.apply.revision).toBe(converged.web.apply.revision);
    expect(after.running.getValue().spec).toEqual(app(5));
    second.stop();
  });

  // Someone sets web to v1, then tries v2, but saving v2 fails. Asked for its spec, the system answers v1: the
  // last spec the sink actually saved, never one that only got as far as being asked for.
  it('reports as its spec the last one the sink saved', async () => {
    const saved: SystemSpec<WebOnly>[] = [];
    const sink = async (spec: SystemSpec<WebOnly>) => {
      if (spec.web?.version === 2) throw new Error('disk full');
      saved.push(spec);
    };
    const web = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ controllers: { web: web.controller }, sink });

    await system.set('web', app(1));
    await expect(system.set('web', app(2))).rejects.toThrow('disk full');

    expect(system.spec()).toEqual(saved.at(-1));
    expect(system.spec()).toEqual({ web: app(1) });
    system.stop();
  });
});

describe('stopping', () => {
  // Web is told to run v1 and the runtime starts working on it. Before it finishes, the system is stopped. The
  // runtime's abort signal fires, so it can give up. Then an hour passes. Nothing calls the runtime again: no
  // retry or backoff timer survives stop().
  it('aborts the apply in flight, and nothing is retried afterwards', async () => {
    vi.useFakeTimers();
    const web = new FakeRuntime();
    const system = await started({ controllers: { web: web.controller } });
    const boot = await web.next();
    boot.succeed();

    await system.set('web', app(1));
    const call = await web.next();
    system.stop();

    expect(call.signal.aborted).toBe(true);
    // Long past every backoff: a stopped convergence must not wake up and try again.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(web.calls).toHaveLength(2);
  });

  // Web is running v1 when the system is stopped. The runtime keeps running v1, and the system never asks it to
  // finalize. Stopping means the system stops managing things, as on a restart. Removing a key is what tears it
  // down.
  it('leaves the runtime running as it was: stopping is not removing', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ controllers: { web: web.controller } });
    await system.set('web', app(1));
    await until(system, s => s.web.apply.revision === revisionFor(app(1)) && s.web.apply.state === 'applied');

    system.stop();
    await flush();

    expect(web.running.getValue().spec).toEqual(app(1));
    expect(web.calls.at(-1)?.kind).toBe('execute');
  });

  // Someone sets web to v1, and the disk is slow, so the save is still under way when the system is told to stop. A
  // caller still holding the mutator's context then tries to set v7, and is turned away. The system doesn't finish stopping
  // until the v1 save completes, so nothing is still writing to storage once stop() resolves. V1 is saved, ready for
  // the next start, but this system never applies it.
  it('turns changes away once stopping, and finishes the save already under way before it stops', async () => {
    const stored: (number | undefined)[] = [];
    const saving: (() => void)[] = [];
    const sink = async (spec: SystemSpec<WebOnly>) => {
      await new Promise<void>(resolve => saving.push(resolve));
      stored.push(spec.web?.version);
    };
    const web = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ controllers: { web: web.controller }, sink });
    const first = system.set('web', app(1));
    await flush();

    let stopped = false;
    const stopping = system.stop().then(() => {
      stopped = true;
    });
    await expect(system.set('web', app(7))).rejects.toThrow(NotMutating);
    await flush();
    expect(stopped).toBe(false);

    saving[0]?.();
    await first;
    await stopping;
    expect(stored).toEqual([1]);
    expect(web.history).not.toContain(1);
  });

  // Web is part-way through applying v1 when the system is stopped. The system aborts the apply, but this runtime
  // ignores the abort and keeps going, so the system waits. Only once the apply has finished does it tell the
  // runtime to dispose, so the runtime never has to release its timers while an apply is still using them. Disposing
  // happens once, and the key is never finalized: the runtime is let go of, not torn down.
  it('disposes each runtime once, only after its calls have settled, and never finalizes', async () => {
    const web = new FakeRuntime(false);
    const dispose = vi.fn();
    const system = await started({ controllers: { web: { ...web.controller, dispose } } });
    const boot = await web.next();
    boot.succeed();
    await system.set('web', app(1));
    const applying = await web.next();

    const stopping = system.stop();
    await flush();
    expect(applying.signal.aborted).toBe(true);
    expect(dispose).not.toHaveBeenCalled();

    applying.succeed();
    await stopping;
    expect(dispose).toHaveBeenCalledOnce();
    expect(web.history).toEqual([undefined, 1]);
  });

  // The mutator is whatever feeds the system changes, such as an API or a file watcher. When the system stops, it
  // aborts the mutator's signal, so a watcher stops watching, and turns away changes made through its context from
  // outside, so an API's routes stop changing anything.
  it('stops its mutator, and turns its changes away', async () => {
    const signals: AbortSignal[] = [];
    const source: MutatorRun<WebOnly> = context => {
      signals.push(context.signal);
    };
    const web = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ controllers: { web: web.controller }, mutator: source });
    expect(signals.map(signal => signal.aborted)).toEqual([false]);

    await system.stop();

    expect(signals.map(signal => signal.aborted)).toEqual([true]);
    await expect(system.set('web', app(1))).rejects.toThrow(NotMutating);
    expect(() => system.context.spec()).toThrow(NotMutating);
  });
});

describe('status', () => {
  // A heartbeat is set to v1 and the system reports it applied. Then the heartbeat beats twice. Each beat shows up
  // in the runtime half of the status. The apply half still says v1 is applied, because the spec hasn't changed.
  // The runtime says what it is doing; the system says whether the runtime has accepted the latest spec.
  it("pairs each runtime's own live status with how far the system has got applying its spec", async () => {
    const beats = new BehaviorSubject(0);
    const heartbeat = controller({ spec: AppSpecSchema, status: beats, execute: async () => undefined });
    const system = await started({ controllers: { heartbeat } });
    await system.set('heartbeat', app(1));
    await until(system, s => s.heartbeat.apply.state === 'applied' && s.heartbeat.apply.revision !== null);

    // The runtime reports on its own schedule; nothing about the spec changed.
    beats.next(1);
    beats.next(2);

    const status = await until(system, s => s.heartbeat.runtime === 2);
    expect(status.heartbeat.apply).toEqual({ state: 'applied', revision: revisionFor(app(1)) });
    system.stop();
  });
});
