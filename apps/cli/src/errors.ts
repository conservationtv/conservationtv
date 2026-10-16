import {
  HandshakeError,
  HttpError,
  OperationVersionChangedError,
  OperationVersionUnavailableError
} from '@conservationtv/studio-sdk';
import { middleware } from 'incur';
import type { GlobalsSchema } from './scope.js';

/** Signing in, or choosing a profile, failed in a way the person can act on. */
export class LoginError extends Error {}

/**
 * Every failure the SDKs return (and the generated commands throw) as a structured error and a failing exit code. Both
 * SDKs share these classes through @conservationtv/versioned-api, so one mapping covers studio and agent commands.
 */
export const mapErrors = middleware<undefined, undefined, typeof GlobalsSchema>(async (context, next) => {
  // Run the command; a failure becomes the first matching error code below, and anything not an Error is rethrown.
  try {
    await next();
  } catch (error) {
    // Most specific first: version negotiation, then handshake, then HTTP status, then login, then any other Error.
    if (error instanceof OperationVersionUnavailableError || error instanceof OperationVersionChangedError) {
      return context.error({ code: 'OPERATION_VERSION_UNAVAILABLE', message: error.message });
    }
    if (error instanceof HandshakeError) return context.error({ code: 'HANDSHAKE_FAILED', message: error.message });
    if (error instanceof HttpError) return context.error({ code: error.code ?? error.name, message: error.message });
    if (error instanceof LoginError) return context.error({ code: 'LOGIN_FAILED', message: error.message });
    if (error instanceof Error) return context.error({ code: 'REQUEST_FAILED', message: error.message });
    throw error;
  }
});
