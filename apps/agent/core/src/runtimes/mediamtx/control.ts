import { MediamtxApi, createClient, createConfig } from '@conservationtv/mediamtx/api';
import { createStore } from '@conservationtv/store';
import { INSTANCE_PATH_PREFIX } from './builders/instance.ts';

// MediaMTX's control API, used here only to tell that a MediaMTX is up and answering, and which one.

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

/** The most paths one page of the config API lists: more than any agent serves. */
const PATHS_PER_PAGE = 1_000;

/** The instance the MediaMTX answering was started as, from the path its config names it by; none if it names none. */
export async function mediamtxInstance(signal: AbortSignal): Promise<string | undefined> {
  const api = useMediamtxClient();
  const listed = await api.configPathsList({ itemsPerPage: PATHS_PER_PAGE }, { signal });
  const marker = listed.data?.items?.find(item => item.name?.startsWith(INSTANCE_PATH_PREFIX));
  return marker?.name?.slice(INSTANCE_PATH_PREFIX.length);
}
