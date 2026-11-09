import { OperationRouter, PUBLISHED_DOCUMENT_PATH } from '@conservationtv/versioned-api/server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { describeRoute } from 'hono-openapi';
import { handleError, handleNotFound } from './middleware/errors.ts';
import account from './routes/account.ts';
import agents from './routes/agents.ts';
import browsers from './routes/browsers.ts';
import cameras from './routes/cameras.ts';
import channelCallbacks from './routes/channel-callbacks.ts';
import channels from './routes/channels.ts';
import deviceAddresses from './routes/device-addresses.ts';
import deviceConfiguration from './routes/device-configuration.ts';
import devices from './routes/devices.ts';
import gatewayEndpoints from './routes/gateway-endpoints.ts';
import gateways from './routes/gateways.ts';
import health from './routes/health.ts';
import invitations from './routes/invitations.ts';
import irohSessions from './routes/iroh-sessions.ts';
import networks from './routes/networks.ts';
import organisations from './routes/organisations.ts';
import reports from './routes/reports.ts';
import shows from './routes/shows.ts';
import streams from './routes/streams.ts';
import subjects from './routes/subjects.ts';
import whoami from './routes/whoami.ts';
import { SHOW_BUNDLE_PATH } from './shows/broadcast.ts';
import { useEnvironment } from './env/env.ts';

/**
 * The requested file from the Worker's static assets (contracts/): the published OpenAPI document, or the show's
 * bundle. The asset server answers `If-None-Match` itself with its own entity tag, so an unchanged file is a 304 with
 * no body. Copied into a new Response so the CORS middleware can add its headers.
 */
const serveStaticAsset = async (c: Context) => {
  const environment = useEnvironment();
  const asset = await environment.assets.fetch(new Request(c.req.url, { headers: c.req.raw.headers }));
  return new Response(asset.body, asset);
};

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
  // The organisation's broadcast, followed over a WebSocket rather than called.
  .route('/organisations/:id/show', shows)
  // Where the broadcast goes out to, and Twitch's return from connecting one (a browser navigation).
  .route('/organisations/:id/channels', channels)
  .route('/channels', channelCallbacks)
  .route('/invitations', invitations)
  // Signed by agents rather than signed in: no session.
  .route('/reports', reports)
  .route('/iroh-sessions', irohSessions)
  .route('/device-configuration', deviceConfiguration)
  .route('/device-addresses', deviceAddresses)
  .route('/gateway-endpoints', gatewayEndpoints)
  // Fetched by gateways, with no session.
  .route('/whoami', whoami)
  .get(PUBLISHED_DOCUMENT_PATH, describeRoute({ hide: true }), serveStaticAsset)
  // The show's bundle (`pnpm bundle:show`, packages/shows): the frame page OBS and the studio open, and the fonts the
  // show is set in, which the studio web app fetches cross-origin.
  .get(`${SHOW_BUNDLE_PATH}*`, describeRoute({ hide: true }), serveStaticAsset)
  .notFound(handleNotFound)
  .onError(handleError);

export default app;
