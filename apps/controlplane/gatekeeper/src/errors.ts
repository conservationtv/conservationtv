import type { ContentfulStatusCode } from 'hono/utils/http-status';

interface ErrorCategory {
  status: ContentfulStatusCode;
  description: string;
}

/**
 * Failure categories and their fixed public descriptions: 401 without the consumer credential, 403 for an endpoint
 * that may not be admitted, and 503 when a dependency the decision needs is unavailable. Malformed requests are the
 * common handler's `invalid_request`.
 */
const categories = {
  invalid_token: { status: 401, description: 'The consumer credential is missing or invalid.' },
  invalid_endpoint_id: { status: 403, description: 'The requested endpoint cannot be admitted.' },
  relay_unavailable: { status: 503, description: 'A dependency required to issue relay credentials is unavailable.' }
} satisfies Record<string, ErrorCategory>;

export type GrantErrorCode = keyof typeof categories;

/** A rejected grant exchange. The code is public; anything diagnostic belongs in `cause`, which is only logged. */
export class GrantError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(
    readonly code: GrantErrorCode,
    options?: ErrorOptions
  ) {
    super(categories[code].description, options);
    this.name = 'GrantError';
    this.status = categories[code].status;
  }
}
