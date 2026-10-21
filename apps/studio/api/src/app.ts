import { OperationRouter, PUBLISHED_DOCUMENT_PATH, servePublishedDocument } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { describeRoute } from 'hono-openapi';
import document from '../contracts/openapi.json' with { type: 'json' };
import { handleError, handleNotFound } from './middleware/errors.ts';
import account from './routes/account.ts';
import agents from './routes/agents.ts';
import browsers from './routes/browsers.ts';
import cameras from './routes/cameras.ts';
import devices from './routes/devices.ts';
import gatewayKeys from './routes/gateway-keys.ts';
import gateways from './routes/gateways.ts';
import health from './routes/health.ts';
import invitations from './routes/invitations.ts';
import irohSessions from './routes/iroh-sessions.ts';
import networks from './routes/networks.ts';
import organisations from './routes/organisations.ts';
import reports from './routes/reports.ts';
import streams from './routes/streams.ts';
import subjects from './routes/subjects.ts';
import whoami from './routes/whoami.ts';
import { useEnvironment } from './env/env.ts';

export const operationRouter = new OperationRouter();

const app = new Hono({ router: operationRouter })
  // The studio web app calls with its session cookie, so its origins are allowed explicitly, never `*`.
  .use(
    cors({
      origin: origin => {
        const environment = useEnvironment();
        return environment.variables.WEB_ORIGINS.includes(origin) ? origin : null;
      },
      credentials: true,
      allowHeaders: ['Authorization', 'Content-Type', 'Operation-Version'],
      exposeHeaders: ['Operation-Version']
    })
  )
  .route('/', health)
  // Better Auth's own routes (sign-in codes, passkeys, sessions) are its contract, not this API's.
  .on(['GET', 'POST'], '/auth/*', describeRoute({ hide: true }), async c => {
    const environment = useEnvironment();
    const auth = await environment.auth();
    return auth.handler(c.req.raw);
  })
  .route('/account', account)
  .route('/organisations', organisations)
  // The stream topology each organisation owns, and what its agents report about it.
  .route('/organisations/:id/networks', networks)
  .route('/organisations/:id/devices', devices)
  .route('/organisations/:id/cameras', cameras)
  .route('/organisations/:id/browser', browsers)
  .route('/organisations/:id/agents', agents)
  .route('/organisations/:id/gateways', gateways)
  .route('/organisations/:id/streams', streams)
  .route('/organisations/:id/subjects', subjects)
  .route('/invitations', invitations)
  // Signed by agents rather than signed in: no session.
  .route('/reports', reports)
  .route('/iroh-sessions', irohSessions)
  // Fetched by gateways, with no session.
  .route('/gateway-keys', gatewayKeys)
  .route('/whoami', whoami)
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), servePublishedDocument(document))
  .notFound(handleNotFound)
  .onError(handleError);

export default app;
