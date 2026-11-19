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

/** The failures the handler renders itself, when the API's renderer falls through. */
export type CommonFailureCode = 'not_found' | 'operation_version_mismatch' | 'invalid_request' | 'server_error';

export interface ErrorHandlerOptions {
  /** Told the code of each common failure as it is rendered; the API's renderer knows its own. */
  onRender?(code: CommonFailureCode): void;
}

/** A common failure's code, description, status and headers. */
interface CommonFailure {
  code: CommonFailureCode;
  description: string;
  status: ContentfulStatusCode;
  headers?: Record<string, string>;
}

/** Routing and version selection, then validation (Hono's 400s), and finally an opaque 500 logged with its cause. */
function commonFailure(error: Error): CommonFailure {
  if (error instanceof NotFoundError) return { code: 'not_found', description: error.message, status: 404 };
  if (error instanceof OperationVersionMismatchError) {
    const served = error.served.length ? error.served.join(',') : 'versionless';
    return {
      code: 'operation_version_mismatch',
      description: error.message,
      status: 412,
      headers: { [OPERATION_VERSION_HEADER]: served }
    };
  }
  if (error instanceof HTTPException && error.status === 400) {
    return { code: 'invalid_request', description: error.message, status: 400 };
  }
  console.error(error);
  return { code: 'server_error', description: 'Unexpected server error', status: 500 };
}

/**
 * Every failure renders as `{ error, error_description }`: the API's own errors first, then the common ones
 * (`commonFailure`), most specific first.
 */
export function createErrorHandler(render?: ErrorRenderer, options: ErrorHandlerOptions = {}): ErrorHandler {
  return (error, c) => {
    const rendered = render?.(error, c);
    if (rendered) return rendered;
    const { code, description, status, headers } = commonFailure(error);
    options.onRender?.(code);
    return apiError(c, code, description, status, headers);
  };
}
