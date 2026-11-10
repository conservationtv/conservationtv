import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvitationAcceptParams, InvitationDeclineParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// Invitations as the person invited sees them (apps/studio/api/src/routes/invitations.ts): those waiting for the
// signed-in account, and the one an emailed link opens. An organisation's own list is in src/queries/members.ts.

/** The open invitations to the signed-in account, oldest first. */
export const ownInvitationListQueryOptions = () =>
  queryOptions({
    queryKey: ['invitations', 'mine'] as const,
    queryFn: async () => {
      const result = await api.invitations.listMine.v1();
      if (result instanceof Error) throw result;
      return result.invitations;
    }
  });

/** The invitation a link opens: the organisation it is for, and whether accepting it needs the link's code. */
export const invitationQueryOptions = (invitationId: string) =>
  queryOptions({
    queryKey: ['invitations', 'detail', invitationId] as const,
    queryFn: async () => {
      const result = await api.invitations.get.v1({ id: invitationId });
      if (result instanceof Error) throw result;
      return result;
    }
  });

/** Join the organisation, going by `displayName` there; an emailed invitation needs its link's `code`. */
export function useAcceptInvitation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (acceptance: InvitationAcceptParams) => {
      const result = await api.invitations.accept.v1(acceptance);
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['invitations'] }),
        client.invalidateQueries({ queryKey: ['organisations', 'list'] })
      ])
  });
}

/** Turn an invitation down. */
export function useDeclineInvitation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (refusal: InvitationDeclineParams) => {
      const result = await api.invitations.decline.v1(refusal);
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['invitations'] })
  });
}
