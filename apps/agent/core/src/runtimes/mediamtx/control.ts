import { MediamtxApi, createClient, createConfig } from '@conservationtv/mediamtx/api';
import { createStore } from '@conservationtv/store';

// MediaMTX's control API, used here only to tell that a MediaMTX is up and answering, and which version it is.

/** The control API. The agent supplies it on start; runtimes read it with `useMediamtxClient()`. */
export const [withMediamtxClient, useMediamtxClient] = createStore<MediamtxApi>('mediamtx');

/** The control API at `baseUrl`, such as `http://127.0.0.1:9997` (`reach.api`, reach.ts). */
export function createMediamtxClient(baseUrl: string): MediamtxApi {
  const config = createConfig({ baseUrl });
  const client = createClient(config);
  return new MediamtxApi({ client });
}

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
