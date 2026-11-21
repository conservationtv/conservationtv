import { controller } from '@conservationtv/converge';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { useStudio } from '../studio.ts';
import { PeersSchema, type Peers } from './admission.ts';

// The `peers` key: who the agent serves over iroh, as the studio API says (the organisation's other agents and its
// browsers, browsers through the relay alone). Kept in the spec, so an agent that restarts knows them before it has
// asked again. Until a studio API that says who they are has been asked, the agent serves anyone, as it always did.
//
// The list is as old as the last configuration (system/configuration.ts), and a browser becomes a device the moment
// someone signs in. So a peer that isn't on it is not refused at once: the studio API is asked who the agent serves
// again first, no more often than every few seconds, and the peer refused only if it still isn't there.

const logger = getLogger(['agent']);

/** How long between asking again on account of an unknown peer: however many dial, the studio API is asked this often. */
const RECHECK_INTERVAL_MS = 5_000;
/** How long the studio API gets to say: a peer waiting to be admitted is not kept longer. */
const RECHECK_TIMEOUT_MS = 5_000;

export const PeersSpecSchema = z.object({ peers: PeersSchema });
export type PeersSpec = z.output<typeof PeersSpecSchema>;

/** How many peers the agent serves; null while it serves anyone. */
export interface PeersStatus {
  peers: number | null;
}

/** The peers the agent serves now, which admission reads for each connection and each request. */
export class PeerList {
  readonly status$ = new BehaviorSubject<PeersStatus>({ peers: null });
  private readonly studio: Client;
  private peers: Peers | undefined = undefined;
  private recheckedAt = 0;
  private rechecking: Promise<void> | undefined = undefined;

  constructor() {
    this.studio = useStudio();
  }

  /** The peers to admit; undefined to admit anyone. */
  get current(): Peers | undefined {
    return this.peers;
  }

  /** Whether requests from the peer are answered: anyone while there is no list, then only those on it. */
  serves(endpointId: string): boolean {
    if (this.peers === undefined) return true;
    return this.peers.some(peer => peer.endpointId === endpointId);
  }

  /**
   * Whether the peer is served, asking the studio API again first when it isn't on the list: it may be a device made
   * since the list was read. A failed ask leaves the list as it was.
   */
  async admits(endpointId: string | undefined): Promise<boolean> {
    if (endpointId === undefined) return this.peers === undefined;
    if (this.serves(endpointId)) return true;
    await this.recheck();
    return this.serves(endpointId);
  }

  /** Ask who the agent serves, unless that was asked a moment ago: everyone waiting shares one ask. */
  private recheck(): Promise<void> {
    if (this.rechecking !== undefined) return this.rechecking;
    if (Date.now() - this.recheckedAt < RECHECK_INTERVAL_MS) return Promise.resolve();
    this.recheckedAt = Date.now();
    const asking = this.ask().finally(() => {
      this.rechecking = undefined;
    });
    this.rechecking = asking;
    return asking;
  }

  private async ask(): Promise<void> {
    const signal = AbortSignal.timeout(RECHECK_TIMEOUT_MS);
    const configuration = await this.studio.deviceConfiguration.get.v3({ signal }).catch((error: Error) => error);
    if (configuration instanceof Error) {
      logger.warn('Asking who the agent serves failed: {error}', { error: configuration });
      return;
    }
    this.set(configuration.peers);
  }

  set(peers: Peers | undefined): void {
    this.peers = peers;
    this.status$.next({ peers: peers === undefined ? null : peers.length });
  }
}

/** The `peers` key's runtime, as a converge controller. */
export function peersController(list: PeerList) {
  return controller({
    spec: PeersSpecSchema,
    status: list.status$,
    execute: async spec => list.set(spec.peers),
    finalize: async () => list.set(undefined),
    dispose: () => undefined
  });
}
