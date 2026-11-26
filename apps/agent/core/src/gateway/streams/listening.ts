import { type Client, MediamtxApi, createClient, createConfig } from '@conservationtv/mediamtx/api';
import type { MediamtxListening } from './config.ts';
import type { MediamtxPorts } from './ports.ts';
import { localReach } from './reach.ts';

/**
 * Where the gateway MediaMTX listens now, and how it and the agent reach each other (reach.ts): set before each start
 * of it (chosen.ts), and the same for as long as it runs. Whatever reaches it reads this as it does rather than keeping
 * an address, and its control API (`api`, which the agent puts in scope for `useMediamtxClient`) follows it.
 */
export class GatewayListening {
  readonly api: MediamtxApi;
  private readonly client: Client;
  private current: MediamtxListening;

  constructor(ports: MediamtxPorts) {
    this.current = { ports, reach: localReach(ports) };
    this.client = createClient(createConfig({ baseUrl: this.current.reach.api }));
    this.api = new MediamtxApi({ client: this.client });
  }

  get ports(): MediamtxPorts {
    return this.current.ports;
  }

  get reach(): MediamtxListening['reach'] {
    return this.current.reach;
  }

  /** Where MediaMTX listens from its next start on. */
  set(ports: MediamtxPorts): void {
    this.current = { ports, reach: localReach(ports) };
    this.client.setConfig({ baseUrl: this.current.reach.api });
  }
}
