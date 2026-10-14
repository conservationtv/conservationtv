import { BetterFetchError } from '@better-fetch/fetch';
import { HttpError } from '@conservationtv/studio-sdk';
import { QueryClient } from '@tanstack/react-query';

/** A 4xx from Better Auth or the studio API; transport failures and 5xx responses are worth retrying. */
function isClientError(error: Error): boolean {
  return (error instanceof BetterFetchError || error instanceof HttpError) && error.status < 500;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => !isClientError(error) && failureCount < 2
    }
  }
});
