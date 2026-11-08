import { useMutation } from '@tanstack/react-query';

import { api } from '@/lib/api';

/**
 * Compose the organisation's broadcast from its streams, in a random order. Temporary, until a show has controls.
 * Everyone following the broadcast sees it as its next update; a stage still waiting for a first composition picks it
 * up when it next redials.
 */
export function useComposeBroadcast(organisationId: string) {
  return useMutation({
    mutationFn: async () => {
      const result = await api.organisations.show.compose({ id: organisationId });
      if (result instanceof Error) throw result;
    }
  });
}
