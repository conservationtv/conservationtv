import { MediamtxApi, createClient, createConfig } from '@conservationtv/mediamtx/api';
import { createStore } from '@conservationtv/store';

// MediaMTX's control API, used here only to tell that a MediaMTX is up and answering.

/** The control API. The agent supplies it on start; runtimes read it with `useMediamtxClient()`. */
export const [withMediamtxClient, useMediamtxClient] = createStore<MediamtxApi>('mediamtx');

/** The control API at `address`, such as `127.0.0.1:9997`. */
export function createMediamtxClient(address: string): MediamtxApi {
  const config = createConfig({ baseUrl: `http://${address}` });
  const client = createClient(config);
  return new MediamtxApi({ client });
}

/** Whether a MediaMTX is answering on the API. */
export async function isMediamtxAlive(signal: AbortSignal): Promise<boolean> {
  const api = useMediamtxClient();
  const { response } = await api.info({ signal });
  return response?.ok === true;
}
