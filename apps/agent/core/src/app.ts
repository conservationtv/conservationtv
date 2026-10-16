import { OperationRouter, PUBLISHED_DOCUMENT_PATH, servePublishedDocument } from '@conservationtv/versioned-api/server';
import { Endpoint } from '@number0/iroh';
import { ALPN, serve, type IrohHttpServer } from '@strangecyan/iroh-http-node';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import document from '../contracts/openapi.json' with { type: 'json' };
import { withConfig, type AgentConfiguration } from './config.ts';
import { handleError, handleNotFound } from './middleware/errors.ts';
import status from './routes/status.ts';

export { useConfig, type AgentConfiguration } from './config.ts';

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
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), servePublishedDocument(document))
  .notFound(handleNotFound)
  .onError(handleError);

/** The agent: the app, served as HTTP over iroh on an endpoint whose identity is the configured secret key. */
export class Agent {
  private server: IrohHttpServer | undefined = undefined;

  constructor(readonly config: AgentConfiguration) {}

  /** Bind the endpoint and serve on it. Resolves once requests are being accepted. */
  async start() {
    if (this.server !== undefined) throw new Error('The agent is already started');
    const config = this.config;
    console.log(JSON.stringify({ event: 'starting', name: config.name }));

    const builder = Endpoint.builder();
    builder.applyN0();
    builder.secretKey(Array.from(config.secretKey));
    builder.alpns([ALPN]);
    const endpoint = await builder.bind();

    // The server owns the endpoint from here: disposing it closes the endpoint too. If accepting fails, `closed`
    // rejects unhandled, which the host's process lifecycle treats as fatal.
    this.server = serve(endpoint, (request, peer) =>
      withConfig(config, () => app.fetch(request, { peer: peer.endpointId }))
    );
    const endpointId = endpoint.id();
    console.log(JSON.stringify({ event: 'started', name: config.name, endpointId: endpointId.toString() }));
  }

  /** Stop accepting, close connections, wait for in-flight requests to settle, and close the endpoint. */
  async stop() {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await server[Symbol.asyncDispose]();
  }
}

export default app;
