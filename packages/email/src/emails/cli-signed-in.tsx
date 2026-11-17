import type { FC } from 'react';

import { EmailButton, EmailDetail, EmailDetails, EmailHeading, EmailNote, EmailText } from '../components/content.tsx';
import { EmailMessage, EmailFooter, EmailHeader, EmailLayout } from '../components/layout.tsx';
import { formatMoment } from '../format.ts';

export interface CliSignedInEmailProps {
  /** The browser and system that approved the CLI's code. */
  approvedFrom: string;
  approvedAt: Date;
  /** The account page, where sessions are signed out. */
  accountUrl: string;
}

/** A security notice: the CLI signed in after someone approved its device code. */
export const CliSignedInEmail: FC<CliSignedInEmailProps> = ({ approvedFrom, approvedAt, accountUrl }) => {
  return (
    <EmailLayout preview="The conservation.tv CLI signed in to your account">
      <EmailHeader />
      <EmailMessage>
        <EmailHeading>The CLI signed in to your account</EmailHeading>
        <EmailText>
          A device code was approved in your browser, and the conservation.tv CLI can now act as you.
        </EmailText>
        <EmailDetails>
          <EmailDetail label="Approved from">{approvedFrom}</EmailDetail>
          <EmailDetail label="When">{formatMoment(approvedAt)}</EmailDetail>
        </EmailDetails>
        <EmailNote>Didn't approve this? Sign the CLI's session out from your account page.</EmailNote>
        <EmailButton href={accountUrl}>Review sessions</EmailButton>
      </EmailMessage>
      <EmailFooter>We send security notices to your account's address whenever the CLI signs in to it.</EmailFooter>
    </EmailLayout>
  );
};

const preview: CliSignedInEmailProps = {
  approvedFrom: 'Chrome on Windows',
  approvedAt: new Date('2026-11-16T09:15:00Z'),
  accountUrl: 'https://studio.conservation.tv/account'
};

export default Object.assign(CliSignedInEmail, { PreviewProps: preview });
