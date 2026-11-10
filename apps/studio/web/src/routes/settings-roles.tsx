import type { FC, ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Badge } from '@conservationtv/ui/components/badge';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle
} from '@conservationtv/ui/components/item';

import { Section, SectionDescription, SectionHeader, SectionHeading, SectionTitle } from '@/components/common/page';
import {
  FOLLOWING_ROLES,
  holds,
  memberName,
  otherHeldRoles,
  PERSON_ROLES,
  type ListedMember
} from '@/components/settings/roles';
import { useOrganisationId } from '@/hooks/use-organisation';
import { memberListQueryOptions } from '@/queries/members';

/**
 * What each role in the organisation lets its holders do, and which members hold the roles people can hold. Nothing
 * here changes anything: administrator is granted on the Members tab, and every other role follows from what its
 * holder is.
 */
const SettingsRolesRoute: FC = () => {
  const organisationId = useOrganisationId();
  const membersQuery = useSuspenseQuery(memberListQueryOptions(organisationId));
  const members = membersQuery.data;
  const others = otherHeldRoles(members);
  return (
    <>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>People</SectionTitle>
            <SectionDescription>
              Everyone who joins is a member. Administrator is the only role given by hand: an administrator makes
              someone one on the Members tab.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <ItemGroup className="gap-2">
          {PERSON_ROLES.map(role => (
            <RoleItem key={role.id} label={role.label} description={role.description}>
              <RoleHolders members={members.filter(member => holds(member, role.id))} />
            </RoleItem>
          ))}
          {others.map(role => (
            <RoleItem key={role.id} label={role.label}>
              <RoleHolders members={members.filter(member => holds(member, role.id))} />
            </RoleItem>
          ))}
        </ItemGroup>
      </Section>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Devices and broadcasting</SectionTitle>
            <SectionDescription>
              These follow from what something is, rather than being given to anyone, and can’t be changed here.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <ItemGroup className="gap-2">
          {FOLLOWING_ROLES.map(role => (
            <RoleItem key={role.id} label={role.label} description={role.description} />
          ))}
        </ItemGroup>
      </Section>
    </>
  );
};

export default SettingsRolesRoute;

interface RoleItemProps {
  label: string;
  /** What the role lets its holders do, where it is one this page knows. */
  description?: string;
  /** Who holds it, if that is shown. */
  children?: ReactNode;
}

/** A role: its name, what it allows, and below, who holds it. */
const RoleItem: FC<RoleItemProps> = ({ label, description, children }) => {
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        {description && <ItemDescription className="line-clamp-none">{description}</ItemDescription>}
      </ItemContent>
      {children && <ItemFooter className="justify-start border-t border-border pt-2.5">{children}</ItemFooter>}
    </Item>
  );
};

interface RoleHoldersProps {
  /** The members who hold the role. */
  members: ListedMember[];
}

/** The members holding a role, by the names they go by here. */
const RoleHolders: FC<RoleHoldersProps> = ({ members }) => {
  if (members.length === 0) return <span className="text-custom-12 text-custom-text-secondary">No one</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {members.map(member => (
        <Badge key={member.userId} variant="outline">
          {memberName(member)}
        </Badge>
      ))}
    </div>
  );
};
