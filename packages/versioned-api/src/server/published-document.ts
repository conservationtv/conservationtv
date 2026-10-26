import type { Context } from 'hono';

/** Where version-aware clients read the contracts a server publishes. */
export const PUBLISHED_DOCUMENT_PATH = '/openapi.json';

/** An OpenAPI bundle as the API imports it from its contracts directory; only serialized, never read here. */
export interface PublishedDocument {
  readonly openapi: string;
}

/** A plain response handler: no `any` from Hono's generic Handler type, so the app's route types stay inferable. */
export type PublishedDocumentHandler = (c: Context) => Promise<Response>;

interface Published {
  body: string;
  etag: string;
}

/** Hash once per isolate; the document is part of the deployed code, so it cannot change underneath. */
async function publish(document: PublishedDocument): Promise<Published> {
  const body = JSON.stringify(document);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { body, etag: `"${hex.slice(0, 32)}"` };
}

/** Whether an `If-None-Match` value names this entity tag. Weak comparison, as RFC 9110 requires for GET. */
function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some(candidate => candidate.trim().replace(/^W\//, '') === etag);
}

/**
 * Serve the published OpenAPI bundle with a strong entity tag. `no-cache` lets browsers keep it but revalidate on
 * every handshake, so a deploy is seen at once while an unchanged document costs a 304 with no body. The SDK sends
 * `If-None-Match` itself too, so runtimes without an HTTP cache, such as Node, get the same. A long max-age would be
 * faster still, but the SDK re-handshakes after a version mismatch and must then see the new document.
 */
export function servePublishedDocument(document: PublishedDocument): PublishedDocumentHandler {
  let published: Promise<Published> | undefined = undefined;
  return async c => {
    if (published == null) published = publish(document);
    const { body, etag } = await published;
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    if (matches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
    return c.body(body, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  };
}
