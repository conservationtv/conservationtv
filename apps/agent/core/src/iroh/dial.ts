import { type Endpoint, EndpointAddr, EndpointId } from '@number0/iroh';
import { connect, type IrohHttpClient } from '@strangecyan/iroh-http-node';

// Calling another agent of the organisation, as HTTP over iroh, from the agent's own endpoint: the one it serves on,
// so the other agent sees this agent's endpoint ID as the request's peer, and admits it as one of its peers. Every
// device is on the same relay, so another agent is found at its endpoint ID there, with no address lookup.

/** How long another agent gets to answer a dial: one that is off never refuses, it just isn't there. */
const DIAL_TIMEOUT_MS = 10_000;

/** Dials the organisation's other agents, once the agent's endpoint is up, keeping a connection to each. */
export class AgentDialler {
  private endpoint: Endpoint | undefined = undefined;
  private relayUrl: string | undefined = undefined;
  private readonly clients = new Map<string, Promise<IrohHttpClient>>();

  /** Dial from this endpoint, finding other agents on this relay, from now on. */
  attach(endpoint: Endpoint, relayUrl: string | undefined): void {
    this.endpoint = endpoint;
    this.relayUrl = relayUrl;
  }

  /** Close every connection, and dial no more. */
  detach(): void {
    this.endpoint = undefined;
    for (const client of this.clients.values()) void client.then(open => open.close()).catch(() => undefined);
    this.clients.clear();
  }

  /** A request to the agent with this endpoint ID, at a path of its API: a connection that fails is dialled afresh. */
  async fetch(endpointId: string, path: string, init: RequestInit): Promise<Response> {
    const client = await this.client(endpointId);
    try {
      return await client.fetch(path, init);
    } catch (error) {
      this.clients.delete(endpointId);
      client.close();
      throw error;
    }
  }

  private client(endpointId: string): Promise<IrohHttpClient> {
    const open = this.clients.get(endpointId);
    if (open !== undefined) return open;
    const dialling = this.dial(endpointId);
    this.clients.set(endpointId, dialling);
    dialling.catch(() => this.clients.delete(endpointId));
    return dialling;
  }

  private async dial(endpointId: string): Promise<IrohHttpClient> {
    const { endpoint } = this;
    if (endpoint === undefined) throw new Error('The agent’s endpoint is not up yet');
    const address = new EndpointAddr(EndpointId.fromString(endpointId), this.relayUrl);
    const timeout = AbortSignal.timeout(DIAL_TIMEOUT_MS);
    const expired = new Promise<never>((_, reject) => {
      timeout.addEventListener('abort', () => reject(new Error(`Agent ${endpointId} did not answer`)), { once: true });
    });
    const dialled = connect(endpoint, address);
    // A dial that lands after giving up is closed rather than left open.
    dialled.then(client => timeout.aborted && client.close()).catch(() => undefined);
    return Promise.race([dialled, expired]);
  }
}
