import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import document from '../openapi.json' with { type: 'json' };
import { handleError, handleNotFound } from './middleware/errors.ts';
import grants from './routes/grants.ts';
import health from './routes/health.ts';
import relays from './routes/relays.ts';
import { OperationRouter } from './utils/operation-versions.ts';

export const operationRouter = new OperationRouter();

const app = new Hono({ router: operationRouter })
  .route('/', health)
  .route('/grants', grants)
  .route('/', relays)
  .get('/openapi.json', describeRoute({ hide: true }), c => c.json(document, 200))
  .notFound(handleNotFound)
  .onError(handleError);

export default app;
