import { mutator } from '@conservationtv/converge';
import { OperationRouter, PUBLISHED_DOCUMENT_PATH, servePublishedDocument } from '@conservationtv/versioned-api/server';
import { serve, type IrohHttpServer } from '@strangecyan/iroh-http-node';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import document from '../contracts/openapi.json' with { type: 'json' };
import { withConfig, type AgentConfiguration } from './config.ts';
import { admitPeers } from './admission.ts';
import { bindEndpoint } from './iroh.ts';
import { handleError, handleNotFound } from './middleware/errors.ts';
import status from './routes/status.ts';
import system from './routes/system.ts';
import { type AgentControllers, startSystem, withSpecApi, withSystem, type AgentSystem } from './system.ts';

export { PeersSchema, type Peer, type Peers } from './admission.ts';
export {
  useConfig,
  type AgentConfiguration,
  type ConservationTvConfiguration,
  type DirectConfiguration
} from './config.ts';
export { MediamtxPathsSchema, type MediamtxPath, type MediamtxPaths } from './runtimes/mediamtx/index.ts';

/** Every request arrives over iroh, from a peer the QUIC handshake authenticated: `peer` is its endpoint id. */
export interface AgentBindings {
  peer: string;
}

export interface AgentEnv {
  Bindings: AgentBindings;
}

export const operationRouter = new OperationRouter();

const app = new Hono<AgentEnv>({ router: operationRouter })
  .route('/status', status)
  .route('/system', system)
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), servePublishedDocument(document))
  .notFound(handleNotFound)
  .onError(handleError);

/** The agent: the app, served as HTTP over iroh on an endpoint whose identity is the configured secret key. */
export class Agent {
  private server: IrohHttpServer | undefined = undefined;
  private system: AgentSystem | undefined = undefined;

  constructor(readonly config: AgentConfiguration) {}

  /** Start the runtimes and an iroh session, and serve on its endpoint. Resolves once requests are being accepted. */
  async start() {
    if (this.system !== undefined) throw new Error('The agent is already started');
    console.log(JSON.stringify({ event: 'starting', name: this.config.name, type: this.config.type }));

    const api = mutator<AgentControllers>();
    const system = await startSystem(this.config, api);
    this.system = system;
    const endpoint = await this.bind();

    // The server owns the endpoint from here: disposing it closes the endpoint too. If accepting fails, `closed`
    // rejects unhandled, which the host's process lifecycle treats as fatal.
    // A peer that reached the agent over IP is only known once its handshake completes, so the list is checked again
    // for each request.
    const peers = this.config.peers;
    const listed = (endpointId: string) => peers?.some(peer => peer.endpointId === endpointId) ?? true;
    this.server = serve(
      endpoint,
      (request, peer) => {
        if (!listed(peer.endpointId)) return new Response(null, { status: 403 });
        return withSystem(system, () =>
          withSpecApi(api, () => withConfig(this.config, () => app.fetch(request, { peer: peer.endpointId })))
        );
      },
      { admit: admitPeers(peers) }
    );
    const endpointId = endpoint.id();
    console.log(JSON.stringify({ event: 'started', name: this.config.name, endpointId: endpointId.toString() }));
  }

  /**
   * Stop accepting, close connections, wait for in-flight requests to settle, and close the endpoint. Then stop the
   * runtimes.
   */
  async stop() {
    const server = this.server;
    this.server = undefined;
    await server?.[Symbol.asyncDispose]();
    const system = this.system;
    this.system = undefined;
    await system?.stop();
  }

  /** Bind the endpoint, stopping the runtimes again if that fails, so a failed start leaves nothing running. */
  private async bind() {
    try {
      return await bindEndpoint(this.config);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
}

export default app;
