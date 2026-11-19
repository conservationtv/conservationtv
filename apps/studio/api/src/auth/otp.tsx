import type { CodePurpose } from '@conservationtv/email';
import type { Mailer } from '../email/mailer.ts';

/** How long an emailed code lasts, in seconds: Better Auth's `expiresIn`, and what the email tells people. */
export const OTP_LIFETIME_SECONDS = 5 * 60;

export interface OtpMessage {
  email: string;
  otp: string;
  type: string;
}
export type OtpDelivery = (message: OtpMessage) => Promise<void>;

const subjects = {
  'sign-in': 'Your conservation.tv sign-in code',
  'email-verification': 'Confirm your email address for conservation.tv',
  'change-email': 'Confirm your new email address for conservation.tv'
} satisfies Record<CodePurpose, string>;

const isCodePurpose = (type: string): type is CodePurpose => Object.hasOwn(subjects, type);

/**
 * How sign-in and verification codes reach people: emailed by the mailer (src/email/mailer.ts), or logged in local
 * development. Better Auth's `forget-password` codes are never sent, as there are no passwords.
 */
export function otpDelivery(mail: Mailer): OtpDelivery {
  return async ({ email, otp, type }) => {
    if (!isCodePurpose(type)) throw new Error(`No email for one-time codes of type ${type}`);
    await mail({
      to: email,
      subject: subjects[type],
      body: async () => {
        const { SignInCodeEmail } = await import('@conservationtv/email');
        return <SignInCodeEmail code={otp} purpose={type} expiresInMinutes={OTP_LIFETIME_SECONDS / 60} />;
      },
      log: { event: 'email_otp', type, otp }
    });
  };
}
