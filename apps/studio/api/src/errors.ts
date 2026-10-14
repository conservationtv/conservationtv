import type { ContentfulStatusCode } from 'hono/utils/http-status';

interface ErrorCategory {
  status: ContentfulStatusCode;
  description: string;
}

/** Failure categories and their fixed public descriptions. Diagnostics belong in `cause`, which is only logged. */
const categories = {
  unauthenticated: { status: 401, description: 'Sign in to use this operation.' },
  forbidden: { status: 403, description: 'Your access does not allow this operation.' },
  not_found: { status: 404, description: 'The resource does not exist or is not visible to you.' },
  account_not_found: { status: 404, description: 'The invited account does not exist.' },
  invalid_invitation_code: { status: 403, description: 'The invitation code is not valid.' },
  already_member: { status: 409, description: 'That account is already a member of the organisation.' },
  already_invited: { status: 409, description: 'That recipient already has an open invitation to the organisation.' },
  invitation_expired: { status: 410, description: 'The invitation has expired.' },
  last_admin: { status: 409, description: 'An organisation must keep at least one administrator.' },
  database_unavailable: { status: 503, description: 'The database is unavailable.' }
} satisfies Record<string, ErrorCategory>;

export type ApiFailureCode = keyof typeof categories;

export class ApiFailure extends Error {
  readonly status: ContentfulStatusCode;

  constructor(
    readonly code: ApiFailureCode,
    options?: ErrorOptions
  ) {
    super(categories[code].description, options);
    this.name = 'ApiFailure';
    this.status = categories[code].status;
  }
}
