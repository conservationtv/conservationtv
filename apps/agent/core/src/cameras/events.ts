import { type Observable, Subscription } from 'rxjs';
import type { CameraControlState } from './control.ts';

// A camera's state as Server-Sent Events: a `state` event at once and each time it changes, a `ping` when nothing has
// for a while, so a reader that has gone is noticed by the write failing, and an end after a while, so no stream is
// left open for good. The reader going away cancels the stream (which iroh-http does when the peer stops reading, or
// its connection closes), and that stops everything here: the camera is asked only while someone follows it.

/** How often a quiet stream says it is still there. */
const HEARTBEAT_MS = 15_000;
/** How long a stream lasts before its reader is to ask again. */
const LIFETIME_MS = 10 * 60_000;

const encoder = new TextEncoder();

/** One event, as `text/event-stream` frames it. */
function frame(event: string, data: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
}

/** The states as an event stream's body, ended when they complete, after `LIFETIME_MS`, or when it is cancelled. */
export function eventStream(states: Observable<CameraControlState>): ReadableStream<Uint8Array> {
  const timers: NodeJS.Timeout[] = [];
  const following = new Subscription();
  const stop = () => {
    following.unsubscribe();
    for (const timer of timers) clearTimeout(timer);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => {
        stop();
        controller.close();
      };
      timers.push(setInterval(() => controller.enqueue(frame('ping', '')), HEARTBEAT_MS));
      timers.push(setTimeout(end, LIFETIME_MS));
      following.add(
        states.subscribe({
          next: state => controller.enqueue(frame('state', JSON.stringify(state))),
          complete: end
        })
      );
    },
    cancel() {
      stop();
    }
  });
}
