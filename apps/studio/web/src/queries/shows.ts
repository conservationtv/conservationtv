import { useMutation } from '@tanstack/react-query';

import { API_URL } from '@/lib/auth-client';

/**
 * Compose the organisation's broadcast from its streams, in a random order. Temporary, until a show has controls: it is
 * a hidden route of the API, not an operation of the SDK. Everyone following the broadcast sees it as its next update;
 * a stage still waiting for a first composition picks it up when it next redials.
 */
export function useComposeBroadcast(organisationId: string) {
  return useMutation({
    mutationFn: async () => {
      const url = new URL(`/organisations/${organisationId}/show/compose`, API_URL);
      const response = await fetch(url, { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error(`Couldn’t compose the broadcast (HTTP ${String(response.status)}).`);
    }
  });
}
