import type { FC } from 'react';

import { EmailCode, EmailHeading, EmailNote, EmailText } from '../components/content.tsx';
import { EmailMessage, EmailFooter, EmailHeader, EmailLayout } from '../components/layout.tsx';

/** What a code is for: Better Auth's email one-time code types that the studio sends. */
export type CodePurpose = 'sign-in' | 'email-verification' | 'change-email';

export interface SignInCodeEmailProps {
  code: string;
  purpose: CodePurpose;
  /** How long the code lasts, in minutes. */
  expiresInMinutes: number;
}

interface PurposeCopy {
  heading: string;
  lead: string;
  unexpected: string;
}

const copy = {
  'sign-in': {
    heading: 'Your sign-in code',
    lead: 'Enter this code on the sign-in page to continue to conservation.tv studio.',
    unexpected: "If you didn't try to sign in, you can ignore this email: no one can sign in without the code."
  },
  'email-verification': {
    heading: 'Confirm your email address',
    lead: 'Enter this code in conservation.tv studio to confirm this is your address.',
    unexpected: "If you didn't create an account, you can ignore this email."
  },
  'change-email': {
    heading: 'Confirm your new email address',
    lead: 'Enter this code in conservation.tv studio to move your account to this address.',
    unexpected: "If you didn't ask to change your address, you can ignore this email: your account stays as it is."
  }
} satisfies Record<CodePurpose, PurposeCopy>;

/** A one-time code for signing in or confirming an address (src/auth/otp.ts in the studio API). */
export const SignInCodeEmail: FC<SignInCodeEmailProps> = ({ code, purpose, expiresInMinutes }) => {
  const { heading, lead, unexpected } = copy[purpose];
  return (
    <EmailLayout preview={`${code} is your conservation.tv code`}>
      <EmailHeader />
      <EmailMessage>
        <EmailHeading>{heading}</EmailHeading>
        <EmailText>{lead}</EmailText>
        <EmailCode>{code}</EmailCode>
        <EmailNote>
          The code expires in {expiresInMinutes} minutes and works once. {unexpected}
        </EmailNote>
      </EmailMessage>
      <EmailFooter>You're receiving this because someone entered this address in conservation.tv studio.</EmailFooter>
    </EmailLayout>
  );
};

const preview: SignInCodeEmailProps = { code: '482913', purpose: 'sign-in', expiresInMinutes: 5 };

export default Object.assign(SignInCodeEmail, { PreviewProps: preview });
