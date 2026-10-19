import { MediamtxApi, createClient, createConfig } from '@conservationtv/mediamtx/api';

/** MediaMTX's control API, used here only to tell that a MediaMTX is up and answering. */
export class MediamtxControl {
  private readonly api: MediamtxApi;

  /** @param address Where the API listens, such as `127.0.0.1:9997`. */
  constructor(address: string) {
    const client = createClient(createConfig({ baseUrl: `http://${address}` }));
    this.api = new MediamtxApi({ client });
  }

  /** Whether a MediaMTX is answering on the API. */
  async alive(signal: AbortSignal): Promise<boolean> {
    const { response } = await this.api.info({ signal });
    return response?.ok === true;
  }
}
