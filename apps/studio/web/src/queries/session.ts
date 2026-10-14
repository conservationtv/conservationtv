import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { authClient } from '@/lib/auth-client';
import {
  startAuthentication,
  WebAuthnError,
  type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import { z } from 'zod';
import { withoutPasskeys, withSignIn, type KnownAccount } from '@/lib/known-device';
import { PasskeyError } from '@/lib/passkey-error';
import { apiQueries } from '@/queries/api';
import { passkeyQueries } from '@/queries/passkeys';
import { thisDeviceQueries, updateKnownAccounts } from '@/queries/this-device';

export const sessionQueries = {
  all: () => ['session'] as const,
  /** The signed-in session and user, or null when signed out. */
  current: () =>
    queryOptions({
      queryKey: [...sessionQueries.all(), 'current'] as const,
      queryFn: () => authClient.getSession(),
      staleTime: 60_000
    })
};

/** Queries that don't depend on who is signed in, kept when the session changes. */
const accountIndependent = new Set<unknown>([sessionQueries.all()[0], thisDeviceQueries.all()[0], apiQueries.all()[0]]);

/**
 * Every sign-in or sign-out changes who the API sees, so it drops the cached account data: the next account's
 * queries must never render the previous account's results. Refreshing the session is also what moves the sign-in
 * and device pages on, so a code sign-in calls this only once its "keep me logged in" step is done.
 */
export function useSessionChanged() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.removeQueries({ predicate: query => !accountIndependent.has(query.queryKey[0]) });
    return queryClient.invalidateQueries({ queryKey: sessionQueries.all() });
  };
}

export interface EmailAddress {
  email: string;
}

export interface EmailCode extends EmailAddress {
  otp: string;
}

/** Email a sign-in code. A new email creates the account when the code is used. */
export function useSendSignInCode() {
  return useMutation({
    mutationFn: ({ email }: EmailAddress) => authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })
  });
}

export interface CodeSignIn {
  /** The account's email as the server spells it. */
  email: string;
  /** Whether to offer "Keep me logged in for longer" before moving on. */
  offerPasskey: boolean;
}

/**
 * Sign in by code, remember the account on this browser, and decide whether to offer it a passkey. The caller moves
 * on (refreshing the session) after that offer is settled.
 */
export function useSignInWithCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ email, otp }: EmailCode): Promise<CodeSignIn> => {
      const { user } = await authClient.signIn.emailOtp({ email, otp });
      await updateKnownAccounts(client, accounts => withSignIn(accounts, user.email));
      const offerPasskey = await client.query({ ...passkeyQueries.offer(), staleTime: 0 });
      return { email: user.email, offerPasskey };
    }
  });
}

// Better Auth's error bodies carry a stable code, such as PASSKEY_NOT_FOUND.
const AuthErrorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() });
type AuthErrorBody = z.output<typeof AuthErrorBodySchema>;

/** What verifying a passkey returns: the new session, which the session query then reads. */
interface VerifiedPasskey {
  session: PasskeySession;
}
interface PasskeySession {
  id: string;
}

/** The browser's passkey prompt, offering only the given passkeys. A cancelled or refused prompt is a PasskeyError. */
async function askForPasskey(options: PublicKeyCredentialRequestOptionsJSON, credentialIds: string[]) {
  try {
    const allowCredentials = credentialIds.map(id => ({ id, type: 'public-key' as const }));
    const { clientExtensionResults: _, ...response } = await startAuthentication({
      optionsJSON: { ...options, allowCredentials }
    });
    return response;
  } catch (error) {
    throw new PasskeyError({
      code: error instanceof WebAuthnError ? error.code : 'AUTH_CANCELLED',
      message: 'The passkey prompt was cancelled.'
    });
  }
}

/**
 * Sign in as one remembered account. Better Auth's own `signIn.passkey()` lets the browser offer every passkey it
 * holds for this site, so this runs the same two calls itself with the prompt limited to the account's passkeys: the
 * server checks only the challenge and the passkey actually used. If the server no longer knows that passkey, this
 * browser's record of the account is stale and is forgotten.
 */
export function useSignInWithPasskey() {
  const client = useQueryClient();
  const sessionChanged = useSessionChanged();
  return useMutation({
    mutationFn: async ({ credentialIds }: KnownAccount) => {
      // These two calls opt out of the client's throwing, so their `{ data, error }` result matches their types.
      const options = await authClient.$fetch<PublicKeyCredentialRequestOptionsJSON>(
        '/passkey/generate-authenticate-options',
        { method: 'GET', throw: false }
      );
      if (options.error) {
        const failure: AuthErrorBody = AuthErrorBodySchema.catch({}).parse(options.error);
        throw new PasskeyError(failure);
      }
      const response = await askForPasskey(options.data, credentialIds);
      const verified = await authClient.$fetch<VerifiedPasskey>('/passkey/verify-authentication', {
        method: 'POST',
        body: { response },
        throw: false
      });
      if (verified.error) {
        const failure: AuthErrorBody = AuthErrorBodySchema.catch({}).parse(verified.error);
        throw new PasskeyError(failure);
      }
    },
    onSuccess: async (_result, { email }) => {
      await updateKnownAccounts(client, accounts => withSignIn(accounts, email));
      await sessionChanged();
    },
    onError: async (error, { credentialIds }) => {
      if (error instanceof PasskeyError && error.code === 'PASSKEY_NOT_FOUND') {
        await updateKnownAccounts(client, accounts => withoutPasskeys(accounts, credentialIds));
      }
    }
  });
}

/** Sign out. The account stays remembered on this browser, passkey or not, for one-tap sign-in next time. */
export function useSignOut() {
  const sessionChanged = useSessionChanged();
  return useMutation({
    mutationFn: async () => {
      await authClient.signOut();
    },
    onSuccess: sessionChanged
  });
}
