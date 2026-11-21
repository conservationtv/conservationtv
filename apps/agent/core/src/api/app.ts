import {
  OPERATION_MANIFEST_PATH,
  OperationRouter,
  PUBLISHED_DOCUMENT_PATH,
  servePublishedDocument
} from '@conservationtv/versioned-api/server';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import document from '../../contracts/openapi.json' with { type: 'json' };
import manifest from '../../contracts/operations.json' with { type: 'json' };
import { handleError, handleNotFound } from './errors.ts';
import cameras from './routes/cameras.ts';
import status from './routes/status.ts';
import system from './routes/system.ts';

// The agent API: what peers ask the agent over iroh (iroh/serve.ts). It reads the running system (system/system.ts)
// and its camera control (cameras/control.ts), and nothing else, so contracts.config.ts can import it without starting
// anything.

/**
 * Every request arrives over iroh, from a peer the QUIC handshake authenticated: `peer` is its endpoint id. `identity`
 * is the agent's own, which the grants it is presented are signed as.
 */
export interface AgentBindings {
  peer: string;
  identity: DeviceIdentity;
}

export interface AgentEnv {
  Bindings: AgentBindings;
}

export const operationRouter = new OperationRouter();

const app = new Hono<AgentEnv>({ router: operationRouter })
  .route('/status', status)
  .route('/system', system)
  .route('/cameras', cameras)
  .get(OPERATION_MANIFEST_PATH, describeRoute({ hide: true }), servePublishedDocument(manifest))
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), servePublishedDocument(document))
  .notFound(handleNotFound)
  .onError(handleError);

export default app;
