/**
 * Files the studio keeps for an organisation, such as a camera preset's thumbnail: small objects under a key, kept
 * until they are deleted. The entrypoint binds one store per request; code reads it with `useEnvironment().media`.
 */
export interface Media {
  /** The object under `key`, or null if there is none. */
  get(key: string): Promise<StoredObject | null>;
  /** Keep `bytes` under `key`, replacing anything already there. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Forget the object under `key`. Nothing happens when there is none. */
  delete(key: string): Promise<void>;
}

/** An object as it was kept: its bytes, and what kind of file they are. */
export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}
