import type { ContentfulStatusCode } from 'hono/utils/http-status';

interface ErrorCategory {
  status: ContentfulStatusCode;
  description: string;
}

/** Failure categories and their fixed public descriptions. Diagnostics belong in `cause`, which is only logged. */
const categories = {
  unauthenticated: { status: 401, description: 'Sign in to use this operation.' },
  not_found: { status: 404, description: 'The resource does not exist or is not visible to you.' },
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
