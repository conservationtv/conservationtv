import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvitationCreateParams, MemberUpdateSelfParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// Who is in an organisation, what each may do there, and who has been asked to join
// (apps/studio/api/src/routes/organisations.ts). Every member reads the directory; administrators change it.

/** The organisation's members, longest-standing first, each with the roles they hold there. */
export const memberListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['members', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.members.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.members;
    }
  });

/** The organisation's open invitations. Administrators only: anyone else is refused. */
export const organisationInvitationListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['members', organisationId, 'invitations'] as const,
    queryFn: async () => {
      const result = await api.organisations.invitations.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.invitations;
    }
  });

/** Change the name the signed-in account goes by in this organisation. */
export function useUpdateOwnMembership(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<MemberUpdateSelfParams, 'id'>) => {
      const result = await api.organisations.members.updateSelf.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['members', organisationId] })
  });
}

/** Make a member an administrator. */
export function useGrantAdmin(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const result = await api.organisations.members.grantAdmin.v1({ id: organisationId, userId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['members', organisationId] })
  });
}

/** Stop a member being an administrator. Refused for the last one. */
export function useRevokeAdmin(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const result = await api.organisations.members.revokeAdmin.v1({ id: organisationId, userId });
      if (result instanceof Error) throw result;
    },
    // The signed-in account's own roles come with its organisations.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['members', organisationId] }),
        client.invalidateQueries({ queryKey: ['organisations', 'list'] })
      ])
  });
}

/** Remove a member; `me` is the signed-in account leaving. Refused for the last administrator. */
export function useRemoveMember(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const result = await api.organisations.members.remove.v1({ id: organisationId, userId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['members', organisationId] }),
        client.invalidateQueries({ queryKey: ['organisations', 'list'] })
      ])
  });
}

/** Invite someone by email (they are sent a link) or an existing account by its ID. */
export function useCreateInvitation(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (invitation: Omit<InvitationCreateParams, 'id'>) => {
      const result = await api.organisations.invitations.create.v1({ id: organisationId, ...invitation });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['members', organisationId, 'invitations'] })
  });
}

/** Withdraw an open invitation. */
export function useCancelInvitation(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await api.organisations.invitations.cancel.v1({ id: organisationId, invitationId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['members', organisationId, 'invitations'] })
  });
}
