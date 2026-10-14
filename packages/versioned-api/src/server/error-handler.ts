import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { NotFoundError, OperationVersionMismatchError } from './errors.js';
import { OPERATION_VERSION_HEADER } from './operation-router.js';

export const noStore = { 'Cache-Control': 'no-store' } as const;

/** Render one failure in the family's shape. Every error response is uncacheable. */
export function apiError(
  c: Context,
  error: string,
  description: string,
  status: ContentfulStatusCode,
  headers: Record<string, string> = {}
) {
  return c.json({ error, error_description: description }, status, { ...noStore, ...headers });
}

export const handleNotFound = (c: Context) => apiError(c, 'not_found', 'Route not found', 404);

/** An API's own failures, rendered before the common ones. Return nothing to fall through. */
export type ErrorRenderer = (error: Error, c: Context) => Response | undefined;

/**
 * Every failure renders as `{ error, error_description }`: the API's own errors first, then routing and version
 * selection, then validation (Hono's 400s), and finally an opaque 500 that is logged with its cause.
 */
export function createErrorHandler(render?: ErrorRenderer): ErrorHandler {
  return (error, c) => {
    // Most specific first: the API's own classes, then this package's, then Hono's validation failures.
    const rendered = render?.(error, c);
    if (rendered) return rendered;
    if (error instanceof NotFoundError) return apiError(c, 'not_found', error.message, 404);
    if (error instanceof OperationVersionMismatchError) {
      return apiError(c, 'operation_version_mismatch', error.message, 412, {
        [OPERATION_VERSION_HEADER]: error.served.length ? error.served.join(',') : 'versionless'
      });
    }
    if (error instanceof HTTPException && error.status === 400) {
      return apiError(c, 'invalid_request', error.message, 400);
    }
    console.error(error);
    return apiError(c, 'server_error', 'Unexpected server error', 500);
  };
}
