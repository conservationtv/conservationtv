import { Observable } from 'rxjs';

/** A task given a signal that aborts when its subscriber leaves before it settles. */
export type Task = (signal: AbortSignal) => Promise<void>;

/** Queues a task; the result emits once and completes when the task resolves, or errors when it throws. */
export type Serial = (task: Task) => Observable<void>;

/**
 * Runs tasks one at a time, in subscription order. A task unsubscribed before its turn never starts; one unsubscribed
 * while running has its signal aborted, and the next waits for it to settle.
 */
export function serial(): Serial {
  let tail = Promise.resolve();
  return task =>
    new Observable<void>(subscriber => {
      const controller = new AbortController();
      let settled = false;
      const run = async (): Promise<void> => {
        if (controller.signal.aborted) return;
        try {
          await task(controller.signal);
          subscriber.next();
          subscriber.complete();
        } catch (cause) {
          subscriber.error(cause);
        } finally {
          settled = true;
        }
      };
      tail = tail.then(run);
      return () => {
        if (!settled) controller.abort();
      };
    });
}
