import type { FC } from 'react';
import { useSuspenseQueries, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { BuildingsIcon, PlusIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@conservationtv/ui/components/empty';
import { ItemGroup } from '@conservationtv/ui/components/item';

import { OwnInvitationItem } from '@/components/account/own-invitation';
import {
  Page,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { accountQueryOptions } from '@/queries/account';
import { ownInvitationListQueryOptions } from '@/queries/invitations';
import { organisationListQueryOptions } from '@/queries/organisations';

/**
 * Until the app keeps a current organisation, home opens the first one the account belongs to. An account in none
 * stays here, to start one or accept an invitation waiting for it.
 */
const HomeRoute: FC = () => {
  const organisationsQuery = useSuspenseQuery(organisationListQueryOptions());
  const [first] = organisationsQuery.data;
  if (first) return <Navigate to={`/organisations/${first.id}`} replace />;
  return <NoOrganisation />;
};

export default HomeRoute;

/** Home for an account in no organisation: starting one, and the invitations waiting for it, if there are any. */
const NoOrganisation: FC = () => {
  const [accountQuery, invitationsQuery] = useSuspenseQueries({
    queries: [accountQueryOptions(), ownInvitationListQueryOptions()]
  });
  const invitations = invitationsQuery.data;
  return (
    <Page className="pt-20">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BuildingsIcon />
          </EmptyMedia>
          <EmptyTitle>You’re not in an organisation yet</EmptyTitle>
          <EmptyDescription>
            An organisation holds a group’s cameras, streams and people. Start one, or join one you’ve been invited to.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button nativeButton={false} render={<Link to="/organisations/new" />}>
            <PlusIcon />
            Start an organisation
          </Button>
        </EmptyContent>
      </Empty>
      {invitations.length > 0 && (
        <Section>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Invitations</SectionTitle>
              <SectionDescription>Organisations that have invited your account.</SectionDescription>
            </SectionHeading>
          </SectionHeader>
          <ItemGroup className="gap-2">
            {invitations.map(invitation => (
              <OwnInvitationItem key={invitation.id} invitation={invitation} accountName={accountQuery.data.name} />
            ))}
          </ItemGroup>
        </Section>
      )}
    </Page>
  );
};
