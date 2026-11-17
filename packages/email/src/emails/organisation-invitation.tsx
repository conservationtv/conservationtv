import type { FC } from 'react';

import { EmailButton, EmailFallbackLink, EmailHeading, EmailNote, EmailText } from '../components/content.tsx';
import { EmailMessage, EmailFooter, EmailHeader, EmailLayout } from '../components/layout.tsx';
import { formatDay } from '../format.ts';

export interface OrganisationInvitationEmailProps {
  organisationName: string;
  /** The name of the administrator who sent it, when they're still known. */
  invitedBy?: string;
  /** The web app's page for the invitation, carrying its one-time code. */
  link: string;
  expiresAt: Date;
}

/** An invitation to join an organisation, sent to an email address (src/organisations/delivery.ts in the studio API). */
export const OrganisationInvitationEmail: FC<OrganisationInvitationEmailProps> = ({
  organisationName,
  invitedBy,
  link,
  expiresAt
}) => {
  const inviter = invitedBy ?? 'An administrator';
  return (
    <EmailLayout preview={`${inviter} invited you to join ${organisationName} on conservation.tv`}>
      <EmailHeader />
      <EmailMessage>
        <EmailHeading>Join {organisationName}</EmailHeading>
        <EmailText>
          {inviter} invited you to join <strong>{organisationName}</strong> on conservation.tv studio, where the team
          runs its cameras, channels and live shows.
        </EmailText>
        <EmailButton href={link}>Accept invitation</EmailButton>
        <EmailFallbackLink href={link} />
        <EmailNote>
          The invitation expires on {formatDay(expiresAt)}. Anyone with this link can accept it, so only pass it on to
          someone you'd invite yourself.
        </EmailNote>
      </EmailMessage>
      <EmailFooter>
        You're receiving this because an administrator of {organisationName} invited this address.
      </EmailFooter>
    </EmailLayout>
  );
};

const preview: OrganisationInvitationEmailProps = {
  organisationName: 'Simulo Sanctuary',
  invitedBy: 'Ada Okafor',
  link: 'https://studio.conservation.tv/invitations/7f3c2a9e?code=QK4M-82TZ',
  expiresAt: new Date('2026-11-30T12:00:00Z')
};

export default Object.assign(OrganisationInvitationEmail, { PreviewProps: preview });
