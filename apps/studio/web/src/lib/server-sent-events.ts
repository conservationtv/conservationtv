// Reading a `text/event-stream` body by hand. The browser's `EventSource` only opens URLs it can fetch itself, and an
// agent is reached over iroh (src/lib/agent-connection.ts), so the frames are parsed here from the response's body.

/** One event of a stream: what it is called (`message` when the stream doesn't say), and its data lines joined. */
export interface ServerSentEvent {
  event: string;
  data: string;
}

/** The event a frame's lines make. A frame of comments alone, which servers send to keep a stream open, makes none. */
function eventOf(frame: string): ServerSentEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    // A single space after the colon is the field's separator, not part of its value.
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /u, ''));
  }
  if (event === 'message' && data.length === 0) return undefined;
  return { event, data: data.join('\n') };
}

/**
 * The events of a `text/event-stream` body, as they arrive, until the stream ends. Aborting the signal cancels the
 * body's reader, which ends the events; so does the caller leaving its loop early.
 */
export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  try {
    // Read until the stream ends or is cancelled, giving out each event as its frame completes.
    while (!signal.aborted) {
      // Each chunk is added to what is left of the last, and every whole frame in it is given out: frames end at a
      // blank line, so whatever follows the last blank line waits for the next chunk. Lines may end CR LF, and a
      // chunk may end between the two, so a trailing CR waits with it.
      const chunk = await reader.read();
      if (chunk.done) return;
      pending = (pending + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n');
      const frames = pending.split('\n\n');
      pending = frames.pop() ?? '';
      for (const frame of frames) {
        const event = eventOf(frame);
        if (event) yield event;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}
