import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { admitIrohEndpoint } from '../relays/iroh.ts';
import { admitMoqSession } from '../relays/moq.ts';

// Relay-facing endpoints speak each relay's fixed protocol, so they are hidden from the published contract, SDK and CLI.

const irohStatus = { allow: 200, deny: 403, unauthenticated: 401 } as const;

export default new Hono()
  // moq-relay `--auth-url`: one moq-auth Request per session event. A 2xx carrying a Grant admits, 401 or 403 refuses,
  // and the reply to `end` is ignored.
  .post('/relays/moq/admission', describeRoute({ hide: true }), async c => {
    const admission = await admitMoqSession(c.req.header('authorization'), await c.req.text());

    c.header('Cache-Control', 'no-store');
    // Based on the outcome of the admission.
    switch (admission.outcome) {
      case 'granted':
        return c.json(admission.grant, 200);
      case 'noted':
        return c.body(null, 204);
      case 'refused':
        console.info(JSON.stringify({ event: 'moq_session_refused', reason: admission.reason }));
        return c.json({ error: 'access_denied', error_description: 'The session is not admitted.' }, 403);
      case 'unauthenticated':
        return c.json(
          { error: 'unauthorized', error_description: 'The relay callback requires the relay credential.' },
          401
        );
      case 'malformed':
        return c.json({ error: 'invalid_request', error_description: 'Expected a moq-auth request.' }, 400);
    }
  })
  // iroh-relay `access.http`: a bodiless POST naming the endpoint; `200 true` admits, anything else refuses.
  .post('/relays/iroh/admission', describeRoute({ hide: true }), async c => {
    // Prefer the current header, falling back to the one older relays send.
    const admission = await admitIrohEndpoint(
      c.req.header('authorization'),
      c.req.header('x-iroh-endpoint-id') ?? c.req.header('x-iroh-nodeid')
    );
    c.header('Cache-Control', 'no-store');
    return c.text(admission === 'allow' ? 'true' : 'false', irohStatus[admission]);
  });
