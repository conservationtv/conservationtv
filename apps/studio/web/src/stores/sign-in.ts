import { createContext, useContext } from 'react';
import type { StoreFromStoreConfig } from '@xstate/store';

/**
 * Where sign-in is. `start` shows the remembered accounts, or the email form when there are none; `email` is the
 * email form (optionally filled in); `code` waits for the emailed code; `remember` offers "Keep me logged in for
 * longer" after a code sign-in. The async work (sending codes, signing in, passkeys) lives in TanStack Query
 * mutations, whose callbacks send these events.
 */
export type SignInStep = 'start' | 'email' | 'code' | 'remember';

interface SignInContext {
  step: SignInStep;
  /** The address the email form starts from, or the code was sent to. */
  email: string;
}

interface ShowEmailFormEvent {
  /** An address to fill in, e.g. the account whose passkey didn't work. */
  prefill?: string;
}

interface CodeSentEvent {
  email: string;
}

const initialContext: SignInContext = { step: 'start', email: '' };

export const signInStoreConfig = {
  context: initialContext,
  on: {
    /** "Use a different account", "Use a different email", or a passkey that didn't work (with its address). */
    showEmailForm: (_context: SignInContext, event: ShowEmailFormEvent): SignInContext => ({
      step: 'email',
      email: event.prefill ?? ''
    }),
    /** A code was sent to this address. */
    codeSent: (_context: SignInContext, event: CodeSentEvent): SignInContext => ({ step: 'code', email: event.email }),
    /** Signed in by code, on a device that could keep a passkey for the account. */
    offerPasskey: (context: SignInContext): SignInContext => ({ ...context, step: 'remember' })
  }
};

export type SignInStore = StoreFromStoreConfig<typeof signInStoreConfig>;

/** One store per sign-in, created by SignIn and shared with its steps. */
export const SignInStoreContext = createContext<SignInStore | null>(null);

export function useSignInStore(): SignInStore {
  const store = useContext(SignInStoreContext);
  if (!store) throw new Error('useSignInStore must be used inside SignIn');
  return store;
}
