import type { Media } from './media.ts';

/** Media in an R2 bucket: each object under its key, with its content type as the object's HTTP metadata. */
export function r2Media(bucket: R2Bucket): Media {
  return {
    get: async key => {
      const object = await bucket.get(key);
      if (object === null) return null;
      return { body: object.body, contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' };
    },
    put: async (key, bytes, contentType) => {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    delete: key => bucket.delete(key)
  };
}
