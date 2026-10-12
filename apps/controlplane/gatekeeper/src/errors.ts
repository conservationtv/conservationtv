import type { ContentfulStatusCode } from 'hono/utils/http-status';

interface ErrorCategory {
  status: ContentfulStatusCode;
  description: string;
}

/**
 * Failure categories and their fixed public descriptions. Descriptions never echo registered issuers, subjects or keys:
 * 400 for malformed requests, 401 for authentication and assertion failures, 403 for authenticated requests outside
 * the caller's delegation, and 503 when a dependency the decision needs is unavailable.
 */
const categories = {
  invalid_request: { status: 400, description: 'The request is malformed.' },
  invalid_assertion: { status: 401, description: 'The grant assertion is malformed or invalid.' },
  invalid_token_type: { status: 401, description: 'The grant assertion has an unexpected token type.' },
  unknown_issuer: { status: 401, description: 'The grant assertion issuer is not recognised.' },
  unknown_principal: { status: 401, description: 'The grant assertion principal is not recognised.' },
  unknown_key: { status: 401, description: 'The grant assertion signing key is not recognised.' },
  invalid_signature: { status: 401, description: 'The grant assertion signature is invalid.' },
  invalid_audience: { status: 401, description: 'The grant assertion audience is invalid.' },
  assertion_not_yet_valid: { status: 401, description: 'The grant assertion is not yet valid.' },
  assertion_expired: { status: 401, description: 'The grant assertion has expired.' },
  assertion_replayed: { status: 401, description: 'The grant assertion has already been consumed.' },
  consumer_disabled: { status: 401, description: 'The consumer is not permitted to exchange grants.' },
  unsupported_grant_version: { status: 400, description: 'The grant version is not supported.' },
  invalid_grant: { status: 400, description: 'The signed grant is malformed.' },
  invalid_subject: { status: 403, description: "The grant subject is outside the caller's namespace." },
  capability_not_delegated: {
    status: 403,
    description: "The requested capability is outside the caller's delegation."
  },
  invalid_resource: { status: 403, description: "The requested resource is outside the caller's delegation." },
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

export class NotFoundError extends Error {}

/** The client asked for a version of an operation that this server doesn't serve. `served` is empty if versionless. */
export class OperationVersionMismatchError extends Error {
  constructor(
    readonly operationId: string,
    readonly served: readonly number[],
    requested: string
  ) {
    super(
      served.length === 0
        ? `${operationId} is versionless, so it has no version ${requested}`
        : `${operationId} is served at version ${served.join(', ')}, not ${requested}`
    );
  }
}
