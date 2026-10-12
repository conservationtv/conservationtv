import type { StandardSchemaV1 } from '@standard-schema/spec';
import { getDotPath } from '@standard-schema/utils';
import type { ValidationTargets } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { resolver, validator as openApiValidator } from 'hono-openapi';
import { DuplicateMemberError, parseStrictJson } from '../json.ts';
import { ApiErrorSchema } from '../schemas.ts';

export interface OperationVersionExtension {
  'x-operation-version': number;
}

/** Declare a separately registered contract. Released versions are immutable; keep old routes to serve old clients. */
export function operationVersion(version: number): OperationVersionExtension {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('Operation version must be a positive safe integer');
  return { 'x-operation-version': version };
}

/** An OpenAPI response whose body is `schema` as JSON. Success bodies are inferred; see scripts/infer-responses.ts. */
const json = (description: string, schema: StandardSchemaV1) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } }
});

export const invalidRequest = json('The request or its signed grant is malformed', ApiErrorSchema);
export const unauthorized = json('The grant assertion failed authentication or validation', ApiErrorSchema);
export const forbidden = json("The signed grant exceeds the consumer's delegation", ApiErrorSchema);
export const versionMismatch = json('The selected operation version is not served', ApiErrorSchema);
export const unavailable = json('A dependency required to decide the request is unavailable', ApiErrorSchema);

interface ValidationResult {
  success: boolean;
  error?: ReadonlyArray<StandardSchemaV1.Issue>;
}

/** Validation hook that throws so the app's error handler renders every 400 in the same shape. */
function invalid(result: ValidationResult): void {
  if (result.success) return;
  const message = (result.error ?? [])
    .map(issue => {
      const path = getDotPath(issue);
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  throw new HTTPException(400, { message: message || 'Invalid request' });
}

/** Keep schemas inline while applying the API's error format and preserving hono-openapi metadata and inference. */
export function validator<Schema extends StandardSchemaV1, Target extends keyof ValidationTargets>(
  target: Target,
  schema: Schema
) {
  return openApiValidator(target, schema, invalid);
}

/**
 * Refuse JSON bodies that aren't `application/json` or that repeat a member name, before the validator parses them.
 * Hono caches the body text, so the validator reads the same bytes checked here.
 */
export const strictJsonBody = createMiddleware(async (c, next) => {
  // Media type first, then a strict parse; either failure is a 400 rendered by the common error handler.
  if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw new HTTPException(400, { message: 'Expected Content-Type: application/json' });
  }
  try {
    parseStrictJson(await c.req.text());
  } catch (error) {
    const message = error instanceof DuplicateMemberError ? error.message : 'Malformed JSON';
    throw new HTTPException(400, { message, cause: error });
  }
  await next();
});
