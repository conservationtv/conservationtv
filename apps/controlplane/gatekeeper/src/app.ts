import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import document from '../contracts/openapi.json' with { type: 'json' };
import { handleError, handleNotFound } from './middleware/errors.ts';
import grants from './routes/grants.ts';
import health from './routes/health.ts';
import relays from './routes/relays.ts';
import { OperationRouter, PUBLISHED_DOCUMENT_PATH, servePublishedDocument } from '@conservationtv/versioned-api/server';

export const operationRouter = new OperationRouter();

const app = new Hono({ router: operationRouter })
  .route('/', health)
  .route('/grants', grants)
  .route('/', relays)
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), servePublishedDocument(document))
  .notFound(handleNotFound)
  .onError(handleError);

export default app;
