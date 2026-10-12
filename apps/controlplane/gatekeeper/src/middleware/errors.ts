import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { GrantError, NotFoundError, OperationVersionMismatchError } from '../errors.ts';
import { OPERATION_VERSION_HEADER } from '../utils/operation-versions.ts';

const noStore = { 'Cache-Control': 'no-store' };

export const handleNotFound = (c: Context) =>
  c.json({ error: 'not_found', error_description: 'Route not found' }, 404, noStore);

/** Every failure renders as `{ error, error_description }`. Rejections are logged with their private cause. */
export const handleError: ErrorHandler = (error, c) => {
  if (error instanceof GrantError) {
    console.warn(JSON.stringify({ event: 'grant_rejected', code: error.code, cause: String(error.cause ?? '') }));
    return c.json({ error: error.code, error_description: error.message }, error.status, noStore);
  }
  if (error instanceof NotFoundError) {
    return c.json({ error: 'not_found', error_description: error.message }, 404, noStore);
  }
  if (error instanceof OperationVersionMismatchError) {
    return c.json({ error: 'operation_version_mismatch', error_description: error.message }, 412, {
      ...noStore,
      [OPERATION_VERSION_HEADER]: error.served.length ? error.served.join(',') : 'versionless'
    });
  }
  if (error instanceof HTTPException && error.status === 400) {
    return c.json({ error: 'invalid_request', error_description: error.message }, 400, noStore);
  }
  console.error(error);
  return c.json({ error: 'server_error', error_description: 'Unexpected server error' }, 500, noStore);
};
