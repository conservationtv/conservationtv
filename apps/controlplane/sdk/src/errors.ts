import { z } from 'zod';

// The control plane renders failures as `{ error, error_description }`, where `error` is a stable category code.
const ErrorBodySchema = z.object({ error: z.string(), error_description: z.string().optional() });
export type ErrorBody = z.output<typeof ErrorBodySchema>;

/** A response body as the transport parsed it: JSON, text, or nothing. */
export const ResponseBodySchema = z.json().optional();
export type ResponseBody = z.output<typeof ResponseBodySchema>;

const MessageSchema = z.string().min(1);
type Message = z.output<typeof MessageSchema>;

function message(body: ResponseBody): Message | undefined {
  const parsed = MessageSchema.safeParse(body);
  return parsed.data;
}

/** An HTTP failure, with the server's original response and parsed body available for inspection. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: ResponseBody;

  constructor(
    readonly response: Response,
    body: ResponseBody
  ) {
    // Prefer the server's description, then its code, then a plain-text body, then the bare status.
    const parsed = ErrorBodySchema.safeParse(body);
    const described: ErrorBody | undefined = parsed.data;
    super(described?.error_description ?? described?.error ?? message(body) ?? `HTTP ${response.status}`);
    this.name = new.target.name;
    this.status = response.status;
    this.code = described?.error;
    this.body = body;
  }
}

export class ValidationError extends HttpError {}
export class NotAuthorizedError extends HttpError {}
export class ForbiddenError extends HttpError {}
export class NotFoundError extends HttpError {}

/** Classify by HTTP status, independently of the server's error-body format. */
export function httpError(response: Response, body: ResponseBody): HttpError {
  switch (response.status) {
    case 400:
      return new ValidationError(response, body);
    case 401:
      return new NotAuthorizedError(response, body);
    case 403:
      return new ForbiddenError(response, body);
    case 404:
      return new NotFoundError(response, body);
    default:
      return new HttpError(response, body);
  }
}

/** Preserve Error instances (including fetch/abort errors); wrap any other thrown value as the cause of one. */
export function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const parsed = MessageSchema.safeParse(cause);
  return new Error(parsed.data ?? 'Request failed', { cause });
}
