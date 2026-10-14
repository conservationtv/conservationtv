import type { Config } from '../config.ts';

export interface InvitationMessage {
  email: string;
  organisationName: string;
  /** The web app's page for the invitation, carrying its one-time code. */
  link: string;
}
export type InvitationDelivery = (message: InvitationMessage) => Promise<void>;

/**
 * How invitation links reach people, by the same setting as sign-in codes (src/auth/otp.ts): only logging exists, for
 * local development, so a deployment fails closed until an email provider is wired in.
 */
export function invitationDelivery(mode: Config['OTP_DELIVERY']): InvitationDelivery {
  switch (mode) {
    case 'log':
      return async ({ email, organisationName, link }) => {
        console.info(JSON.stringify({ event: 'organisation_invitation', email, organisation: organisationName, link }));
      };
  }
}
