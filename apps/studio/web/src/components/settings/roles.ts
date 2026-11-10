import type { Member } from '@conservationtv/studio-sdk';

// The roles held in an organisation, as its grants name them, and what each lets its holder do. They mirror the API's
// own definitions (apps/studio/api/src/db/roles.ts), which the member list carries only as `{ id, label }`.

/** A member, as the organisation's directory lists them. */
export type ListedMember = Member['members'][number];

/** A role as the member list carries it. */
export type HeldRole = ListedMember['roles'][number];

/** Every member holds it. */
export const MEMBER_ROLE = '@shared/organisationMember';

/** The role that lets its holders change the organisation: the only one granted by hand. */
export const ADMINISTRATOR_ROLE = '@shared/organisationAdmin';

/** A role and what it lets its holder do. */
export interface RoleDefinition {
  id: string;
  label: string;
  description: string;
}

/** The roles people hold in an organisation. */
export const PERSON_ROLES: readonly RoleDefinition[] = [
  {
    id: MEMBER_ROLE,
    label: 'Member',
    description: 'See the organisation, its members, its stream topology and what its agents observe.'
  },
  {
    id: ADMINISTRATOR_ROLE,
    label: 'Administrator',
    description: 'Manage the organisation, its members, their profiles and its invitations, and its stream topology.'
  }
];

/** The roles that follow from what something is, rather than being given to someone. */
export const FOLLOWING_ROLES: readonly RoleDefinition[] = [
  {
    id: '@shared/channelBroadcaster',
    label: 'Broadcaster',
    description:
      'Read the organisation’s stream keys and channel tokens, to send its broadcast out. Administrators have it as part of their role, and the agent sending the show out holds it while it does.'
  },
  {
    id: '@shared/organisationDevice',
    label: 'Device',
    description:
      'Read the organisation’s devices and their public identities. Every agent, camera and browser in the organisation holds it, from when it is added until it is removed.'
  }
];

/** Whether the member holds the role. */
export function holds(member: ListedMember, roleId: string): boolean {
  return member.roles.some(role => role.id === roleId);
}

/** Whether the member is one of the organisation's administrators. */
export function isAdministrator(member: ListedMember): boolean {
  return holds(member, ADMINISTRATOR_ROLE);
}

/** The roles worth a badge beside a member: all they hold but Member, which everyone holds. */
export function badgeRoles(member: ListedMember): HeldRole[] {
  return member.roles.filter(role => role.id !== MEMBER_ROLE);
}

/** The roles members hold that are none of the ones described here, each once, so none goes unlisted. */
export function otherHeldRoles(members: readonly ListedMember[]): HeldRole[] {
  const described = new Set([...PERSON_ROLES, ...FOLLOWING_ROLES].map(role => role.id));
  const others = new Map<string, HeldRole>();
  for (const role of members.flatMap(member => member.roles)) {
    if (!described.has(role.id)) others.set(role.id, role);
  }
  return [...others.values()];
}

/** The name a member goes by, or a stand-in for one who has none. */
export function memberName(member: ListedMember): string {
  return member.displayName ?? 'Unnamed member';
}
