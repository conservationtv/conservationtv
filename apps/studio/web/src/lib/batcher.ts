// Requests made close together that differ only by the IDs they ask about, such as every stream card's chart reading
// its own exposures' metrics, are sent as one request with every caller's IDs combined, and each caller gets back only
// its own IDs' results. Requests share a batch when their shared parts serialise the same, so callers should build the
// shared part in one place, with its keys, and any arrays in it (a list of metric names, say), in the same order.

export interface BatcherOptions<Shared, Result> {
  /** One request for a batch: the shared part every caller in it asked with, and their IDs combined. */
  request: (shared: Shared, ids: string[]) => Promise<Result[]>;
  /** The ID a result is about, to hand each caller back its own. */
  getId: (result: Result) => string;
  /** The most IDs one request may carry; a batch with more is sent as several requests at once. */
  maxIds?: number;
  /** How long a batch waits after its first request for others to join it. */
  windowMs?: number;
}

/** A caller waiting on a batch: the IDs it asked about, and how to answer it. */
interface Caller<Result> {
  ids: string[];
  resolve: (results: Result[]) => void;
  reject: (error: Error) => void;
}

interface Batch<Shared, Result> {
  shared: Shared;
  callers: Caller<Result>[];
}

const DEFAULT_WINDOW_MS = 50;

/**
 * Collects requests made within a short window that share everything but their IDs, sends them together, and
 * resolves each with the results about its own IDs. A failed request fails every caller in its batch.
 */
export class Batcher<Shared, Result> {
  private readonly options: BatcherOptions<Shared, Result>;
  private readonly batches = new Map<string, Batch<Shared, Result>>();

  constructor(options: BatcherOptions<Shared, Result>) {
    this.options = options;
  }

  /** The results about `ids`, read in a batch with any requests sharing `shared` made within the window. */
  load(shared: Shared, ids: string[]): Promise<Result[]> {
    const key = JSON.stringify(shared);
    const batch = this.batches.get(key) ?? this.open(key, shared);
    return new Promise<Result[]>((resolve, reject) => {
      batch.callers.push({ ids, resolve, reject });
    });
  }

  /** A new batch, sent once its window closes. */
  private open(key: string, shared: Shared): Batch<Shared, Result> {
    const batch: Batch<Shared, Result> = { shared, callers: [] };
    this.batches.set(key, batch);
    setTimeout(() => {
      // Requests from now on open the next batch.
      this.batches.delete(key);
      void this.send(batch);
    }, this.options.windowMs ?? DEFAULT_WINDOW_MS);
    return batch;
  }

  private async send(batch: Batch<Shared, Result>): Promise<void> {
    const { request, getId, maxIds = Infinity } = this.options;
    // Every caller's IDs once, sent in chunks of at most maxIds at once; the results are then split by the ID each is
    // about, and every caller answered with its own IDs' results, or every caller failed with the first error.
    const ids = [...new Set(batch.callers.flatMap(caller => caller.ids))];
    try {
      const answers = await Promise.all(chunksOf(ids, maxIds).map(chunk => request(batch.shared, chunk)));
      const byId = new Map<string, Result[]>();
      for (const result of answers.flat()) {
        const id = getId(result);
        byId.set(id, [...(byId.get(id) ?? []), result]);
      }
      for (const caller of batch.callers) caller.resolve(caller.ids.flatMap(id => byId.get(id) ?? []));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const caller of batch.callers) caller.reject(failure);
    }
  }
}

function chunksOf<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items];
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
