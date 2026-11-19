import type { Mailer } from '../email/mailer.ts';

export interface InvitationMessage {
  email: string;
  organisationName: string;
  /** The inviting administrator's name in the organisation, when they have a profile there. */
  invitedBy: string | undefined;
  /** The web app's page for the invitation, carrying its one-time code. */
  link: string;
  expiresAt: Date;
}
export type InvitationDelivery = (message: InvitationMessage) => Promise<void>;

/** How invitation links reach people: emailed by the mailer (src/email/mailer.ts), or logged in local development. */
export function invitationDelivery(mail: Mailer): InvitationDelivery {
  return async ({ email, organisationName, invitedBy, link, expiresAt }) => {
    await mail({
      to: email,
      subject: `Join ${organisationName} on conservation.tv`,
      body: async () => {
        const { OrganisationInvitationEmail } = await import('@conservationtv/email');
        return (
          <OrganisationInvitationEmail
            organisationName={organisationName}
            invitedBy={invitedBy}
            link={link}
            expiresAt={expiresAt}
          />
        );
      },
      log: { event: 'organisation_invitation', organisation: organisationName, link }
    });
  };
}
