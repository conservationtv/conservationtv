import type { FC } from 'react';
import { useSelector, useStore } from '@xstate/store-react';

import { CodeStep } from '@/components/auth/code-step';
import { EmailStep } from '@/components/auth/email-step';
import { RememberDevice } from '@/components/auth/remember-device';
import { Start } from '@/components/auth/start';
import { PanelHeader } from '@/components/panel';
import { Step, Steps } from '@/components/steps';
import { SignInStoreContext, signInStoreConfig, useSignInStore } from '@/stores/sign-in';

export interface SignInProps {
  title?: string;
}

/**
 * Sign-in. A browser that has signed accounts in before lists them, one tap each: a passkey account opens the passkey
 * prompt, an email-only one sends a code. Otherwise, and for anyone else, it's the email form (a new email creates
 * the account). A passkey that doesn't work lands on the email form with that address filled in. After a code
 * sign-in, a device that could hold a passkey is offered one as "Keep me logged in for longer". The session is
 * refreshed only once that's settled, which is what moves the surrounding page on.
 *
 * Where the flow is lives in a small store (src/stores/sign-in.ts); everything async is a TanStack Query mutation or
 * query, whose callbacks move the store on. This is the card's contents; the page puts it in a SignInFrame.
 */
export const SignIn: FC<SignInProps> = ({ title = 'Sign in to conservation.tv' }) => {
  const store = useStore(signInStoreConfig);
  return (
    <SignInStoreContext value={store}>
      <SignInFlow title={title} />
    </SignInStoreContext>
  );
};

interface SignInFlowProps {
  title: string;
}

/**
 * The steps, in the order the flow moves through them. Those before signing in share the title, which stays still
 * while they slide beneath it; the passkey offer brings its own.
 */
const SignInFlow: FC<SignInFlowProps> = ({ title }) => {
  const step = useSelector(useSignInStore(), snapshot => snapshot.context.step);
  return (
    <Steps active={step}>
      <Step value={['start', 'email', 'code']}>
        <PanelHeader title={title} />
        <Steps active={step}>
          <Step value="start">
            <Start />
          </Step>
          <Step value="email">
            <EmailStep />
          </Step>
          <Step value="code">
            <CodeStep />
          </Step>
        </Steps>
      </Step>
      <Step value="remember">
        <RememberDevice />
      </Step>
    </Steps>
  );
};
