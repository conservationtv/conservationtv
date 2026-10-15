import { OperationRouter, PUBLISHED_DOCUMENT_PATH, servePublishedDocument } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { describeRoute } from 'hono-openapi';
import document from '../contracts/openapi.json' with { type: 'json' };
import { handleError, handleNotFound } from './middleware/errors.ts';
import account from './routes/account.ts';
import agents from './routes/agents.ts';
import devices from './routes/devices.ts';
import health from './routes/health.ts';
import invitations from './routes/invitations.ts';
import networks from './routes/networks.ts';
import organisations from './routes/organisations.ts';
import streams from './routes/streams.ts';
import { useServices } from './services.ts';

export const operationRouter = new OperationRouter();

const app = new Hono({ router: operationRouter })
  // The studio web app calls with its session cookie, so its origins are allowed explicitly, never `*`.
  .use(
    cors({
      origin: origin => {
        const services = useServices();
        return services.config.WEB_ORIGINS.includes(origin) ? origin : null;
      },
      credentials: true,
      allowHeaders: ['Authorization', 'Content-Type', 'Operation-Version'],
      exposeHeaders: ['Operation-Version']
    })
  )
  .route('/', health)
  // Better Auth's own routes (sign-in codes, passkeys, sessions) are its contract, not this API's.
  .on(['GET', 'POST'], '/auth/*', describeRoute({ hide: true }), async c => {
    const services = useServices();
    const auth = await services.auth();
    return auth.handler(c.req.raw);
  })
  .route('/account', account)
  .route('/organisations', organisations)
  // The stream topology each organisation owns, and what its agents report about it.
  .route('/organisations', networks)
  .route('/organisations', devices)
  .route('/organisations', agents)
  .route('/organisations', streams)
  .route('/invitations', invitations)
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), servePublishedDocument(document))
  .notFound(handleNotFound)
  .onError(handleError);

export default app;
