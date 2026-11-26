import type { MediamtxApi } from '@conservationtv/mediamtx/api';
import { createStore } from '@conservationtv/store';

// MediaMTX's control API, used here only to tell that a MediaMTX is up and answering, and which version it is.

/**
 * The control API, wherever MediaMTX listens now (listening.ts). The agent supplies it on start; runtimes read it with
 * `useMediamtxClient()`.
 */
export const [withMediamtxClient, useMediamtxClient] = createStore<MediamtxApi>('mediamtx');

/** Whether a MediaMTX is answering on the API. */
export async function isMediamtxAlive(signal: AbortSignal): Promise<boolean> {
  const api = useMediamtxClient();
  const { response } = await api.info({ signal });
  return response?.ok === true;
}

/** The version the MediaMTX answering on the API says it is, if it says. */
export async function mediamtxVersion(signal: AbortSignal): Promise<string | undefined> {
  const api = useMediamtxClient();
  const { data } = await api.info({ signal });
  return data?.version;
}
