interface PasskeyFailure {
  code?: string | undefined;
  message?: string | undefined;
}

/**
 * A failed or cancelled passkey ceremony. Better Auth's passkey client resolves these as `{ error }` even when the
 * client is set to throw, so the passkey mutations throw them themselves. `code` is Better Auth's or the browser's,
 * e.g. PASSKEY_NOT_FOUND or ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED.
 */
export class PasskeyError extends Error {
  readonly code: string | undefined;

  constructor(failure: PasskeyFailure) {
    super(failure.message ?? 'The passkey did not work.');
    this.name = 'PasskeyError';
    this.code = failure.code;
  }
}
