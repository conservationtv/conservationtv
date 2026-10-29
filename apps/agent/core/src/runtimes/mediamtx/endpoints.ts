import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import type { MediamtxPorts } from './ports.ts';

// Where readers on the network reach the gateway's servers, as this agent's MediaMTX actually serves them, registered
// with the studio API (`gatewayEndpoints.replace`) so `connect` hands out URLs that work. For each protocol, the base
// URL: the gateway's hostname when it has a certificate, or else the address the agent prefers (runtimes/addresses.ts);
// the scheme TLS makes it; and the port MediaMTX listens on (ports.ts).
//
// A registration is a lease, which the studio API lets lapse unless it is renewed, so the agent renews it every
// `RENEW_EVERY_MS` while its MediaMTX serves, and withdraws it when that stops: when the agent is no longer to run the
// gateway, and when the agent stops. Withdrawing on stopping is a courtesy, given `CLOSE_WITHIN_MS` so a slow studio API
// never holds up the rest of shutdown; an agent that runs out of time, or dies outright, leaves its lease to lapse.

const logger = getLogger(['agent', 'mediamtx', 'endpoints']);

/** How often a registration is renewed: well within the lease the studio API grants. */
const RENEW_EVERY_MS = 30_000;

/** How long withdrawing on stopping may take, behind any renewal in flight, before the lease is left to lapse. */
const CLOSE_WITHIN_MS = 2_000;

/** A protocol the gateway serves, and the base URL of its server. */
export interface RealisedEndpoint {
  protocol: 'webrtc' | 'rtsp' | 'rtsps' | 'rtmp' | 'rtmps' | 'hls';
  url: string;
}

/**
 * The base URL of each protocol MediaMTX serves on `ports`, at `host`. With TLS (builders/tls.ts), RTSP and RTMP serve
 * their secure listeners beside the plain ones, and HLS and WebRTC are served over HTTPS instead of HTTP.
 */
export function realisedEndpoints(ports: MediamtxPorts, host: string, tls: boolean): RealisedEndpoint[] {
  const authority = host.includes(':') ? `[${host}]` : host;
  const http = tls ? 'https' : 'http';
  const endpoints: RealisedEndpoint[] = [
    { protocol: 'rtsp', url: `rtsp://${authority}:${ports.rtsp}` },
    { protocol: 'rtmp', url: `rtmp://${authority}:${ports.rtmp}` },
    { protocol: 'hls', url: `${http}://${authority}:${ports.hls}` },
    { protocol: 'webrtc', url: `${http}://${authority}:${ports.webrtc}` }
  ];
  if (tls) {
    endpoints.push({ protocol: 'rtsps', url: `rtsps://${authority}:${ports.rtsps}` });
    endpoints.push({ protocol: 'rtmps', url: `rtmps://${authority}:${ports.rtmps}` });
  }
  return endpoints;
}

/** What is being registered: the gateway, and how to find its endpoints each time, none while there are none. */
interface Registering {
  gatewayId: string;
  find: () => Promise<RealisedEndpoint[]>;
}

/**
 * Keeps one gateway's endpoints registered with the studio API: renewed every `RENEW_EVERY_MS` from whatever `find`
 * says then, until withdrawn. Calls to the studio API happen one at a time, in order, so a renewal in flight never
 * re-registers what a withdrawal after it removed. A failed one is logged, and the next renewal tries again.
 */
export class EndpointRegistration {
  private registering: Registering | undefined = undefined;
  /** The gateway endpoints were last registered for, so withdrawing knows whose, and whether it has anything to do. */
  private registered: string | undefined = undefined;
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly studio: Client) {}

  /** Register the gateway's endpoints from `find`, now and every `RENEW_EVERY_MS` until withdrawn. */
  register(gatewayId: string, find: () => Promise<RealisedEndpoint[]>): void {
    if (this.closed) return;
    this.registering = { gatewayId, find };
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.enqueue(() => this.renew()), RENEW_EVERY_MS);
    void this.enqueue(() => this.renew());
  }

  /** Stop renewing, and withdraw whatever is registered. Resolves once the studio API has been told, or failed to be. */
  withdraw(): Promise<void> {
    this.registering = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    return this.enqueue(() => this.replace(this.registered, []));
  }

  /**
   * Withdraw for good: the agent is stopping. Resolves once withdrawn, or after `CLOSE_WITHIN_MS` whether or not it
   * has been, leaving the lease to lapse.
   */
  async close(): Promise<void> {
    this.closed = true;
    const deadline = new AbortController();
    const timeout = sleep(CLOSE_WITHIN_MS, undefined, { signal: deadline.signal }).then(
      () => logger.warn('Withdrawing the endpoints took too long; their lease will lapse'),
      () => undefined
    );
    await Promise.race([this.withdraw(), timeout]);
    deadline.abort();
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async renew(): Promise<void> {
    const registering = this.registering;
    if (registering === undefined) return;
    // Another gateway's go first: the studio API keeps one set per agent anyway.
    if (this.registered !== undefined && this.registered !== registering.gatewayId) {
      await this.replace(this.registered, []);
    }
    let endpoints: RealisedEndpoint[] = [];
    try {
      endpoints = await registering.find();
    } catch (error) {
      logger.error('Finding the endpoints of gateway {gatewayId} failed: {error}', { ...registering, error });
    }
    await this.replace(registering.gatewayId, endpoints);
  }

  /** Tell the studio API the gateway's endpoints are `endpoints`: with none, withdrawn. */
  private async replace(gatewayId: string | undefined, endpoints: RealisedEndpoint[]): Promise<void> {
    if (gatewayId === undefined) return;
    if (endpoints.length === 0 && this.registered === undefined) return;
    try {
      await this.studio.handshake();
      const result = await this.studio.gatewayEndpoints.replace.v1({ gatewayId, endpoints });
      if (result instanceof Error) throw result;
      this.registered = endpoints.length === 0 ? undefined : gatewayId;
    } catch (error) {
      logger.error('Registering the endpoints of gateway {gatewayId} failed: {error}', { gatewayId, error });
    }
  }
}
