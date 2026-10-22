import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type SystemSpec, controller, converge, mutator } from '../src/index.ts';
import {
  AppSpecSchema,
  FakeRuntime,
  type Running,
  app,
  flush,
  revisionFor,
  started,
  succeedAfter,
  until
} from './harness.ts';

/** A system of one `web` runtime. */
type WebOnly = Record<'web', FakeRuntime['controller']>;

describe('faulty runtimes', () => {
  // Web's runtime has a status stream that breaks. Anyone reading the system's status hears about it, but the
  // system carries on applying regardless: a broken status is a reporting problem, not a reason to stop converging.
  it('keeps applying when a runtime breaks its status stream', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const broken = new BehaviorSubject<Running>({ spec: undefined });
    const flaky = controller({ spec: AppSpecSchema, status: broken, execute: async () => undefined });
    const system = await started({ controllers: { web: web.controller, flaky } });

    broken.error(new Error('status broke'));
    await expect(system.status()).rejects.toThrow('status broke');

    await system.set('web', app(1));
    await vi.waitFor(() => expect(web.running.getValue().spec).toEqual(app(1)));
    await system.stop();
  });

  // Two runtimes throw when disposed, and the mutator's run has already failed. Stopping still disposes every
  // runtime and stops the mutator, then reports all three failures together, so one bad runtime can't leave the
  // others holding on to their timers.
  it('disposes every runtime even when some throw, and reports what failed', async () => {
    const throws = (): never => {
      throw new Error('dispose failed');
    };
    const first = new FakeRuntime(true, succeedAfter(0));
    const second = new FakeRuntime(true, succeedAfter(0));
    const third = new FakeRuntime(true, succeedAfter(0));
    const disposed = vi.fn();
    const signals: AbortSignal[] = [];
    const source = mutator<Record<'first' | 'second' | 'third', FakeRuntime['controller']>>(async context => {
      signals.push(context.signal);
      throw new Error('watcher failed');
    });
    const system = await started({
      controllers: {
        first: { ...first.controller, dispose: throws },
        second: { ...second.controller, dispose: disposed },
        third: { ...third.controller, dispose: throws }
      },
      mutator: source
    });
    await flush();

    const stopping = system.stop();

    await expect(stopping).rejects.toThrow(AggregateError);
    await expect(stopping).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'watcher failed' }), expect.any(Error), expect.any(Error)]
    });
    expect(disposed).toHaveBeenCalledOnce();
    expect(signals.map(signal => signal.aborted)).toEqual([true]);
  });
});

describe('faulty starts', () => {
  // Storage holds something that isn't a valid spec: a version that isn't a whole number, and a key nobody owns.
  // Starting fails straight away, before any runtime has been asked to do anything with it.
  it('refuses to start from a corrupt spec, without touching a runtime', async () => {
    const web = new FakeRuntime();
    const corrupt = { web: { image: 'app', version: 1.5 }, ghost: {} };

    await expect(converge({ controllers: { web: web.controller }, restore: async () => corrupt })).rejects.toThrow();

    expect(web.calls).toHaveLength(0);
  });

  // The mutator's run throws while starting. The start fails, but not before the system has stopped, so nothing is
  // left running in the background, and the mutator is let go of, so it can be tried again.
  it('stops again when the mutator throws while starting, leaving nothing running', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const dispose = vi.fn();
    const broken = mutator<WebOnly>(() => {
      throw new Error('mutator failed to start');
    });

    const starting = converge({ controllers: { web: { ...web.controller, dispose } }, mutator: broken });

    await expect(starting).rejects.toThrow('mutator failed to start');
    expect(dispose).toHaveBeenCalledOnce();
    expect(broken.attached).toBe(false);
  });

  // One mutator, handed to two systems: the second can't start, because its changes would race the first's. The
  // first carries on, still changed through the mutator.
  it('refuses a mutator already changing another system', async () => {
    const first = new FakeRuntime(true, succeedAfter(0));
    const second = new FakeRuntime(true, succeedAfter(0));
    const dispose = vi.fn();
    const system = await started({ controllers: { web: first.controller } });

    const starting = converge({ controllers: { web: { ...second.controller, dispose } }, mutator: system.mutator });

    await expect(starting).rejects.toThrow('already changing another system');
    expect(dispose).toHaveBeenCalledOnce();
    await system.set('web', app(1));
    expect(system.spec()).toEqual({ web: app(1) });
    await system.stop();
  });
});

describe('faulty mutators', () => {
  // A careless caller sets web to a spec with a version that isn't a whole number, then replaces the whole spec with
  // one that has a key nobody owns. Both are turned away before they reach storage or a runtime.
  it('rejects specs that do not parse, before they are saved or applied', async () => {
    const saved: SystemSpec<WebOnly>[] = [];
    const sink = async (spec: SystemSpec<WebOnly>) => {
      saved.push(spec);
    };
    const web = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ controllers: { web: web.controller }, sink });
    const ghost = { web: app(1), ghost: app(1) };

    await expect(system.set('web', { image: 'app', version: 1.5 })).rejects.toThrow();
    await expect(system.replace(ghost)).rejects.toThrow();

    expect(saved).toEqual([]);
    expect(web.history).toEqual([undefined]);
    await system.stop();
  });

  // A file watcher reacts to its own writes, so it keeps setting web to the same spec, over and over. Only the first
  // set is saved and applied. Every set after it changes nothing, so it goes no further: storage isn't written again
  // and the runtime isn't disturbed.
  it('lets a mutator that loops on the same spec do no harm', async () => {
    let writes = 0;
    const sink = async () => {
      writes++;
    };
    const web = new FakeRuntime(true, succeedAfter(0));
    const system = await started({ controllers: { web: web.controller }, sink });

    for (let turn = 0; turn < 50; turn++) await system.set('web', app(1));
    await until(system, s => s.web.apply.state === 'applied' && s.web.apply.revision === revisionFor(app(1)));

    expect(writes).toBe(1);
    expect(web.history).toEqual([undefined, 1]);
    await system.stop();
  });
});

describe('stopping twice', () => {
  // Two parts of the agent's shutdown both ask the system to stop. They share one stop: the runtime is disposed
  // once, and both are told when it has finished.
  it('stops once, however many times it is asked', async () => {
    const web = new FakeRuntime(true, succeedAfter(0));
    const dispose = vi.fn();
    const system = await converge({ controllers: { web: { ...web.controller, dispose } } });
    await flush();

    await Promise.all([system.stop(), system.stop()]);

    expect(dispose).toHaveBeenCalledOnce();
  });
});
