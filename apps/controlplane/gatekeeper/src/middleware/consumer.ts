import { createMiddleware } from 'hono/factory';
import { useEnvironment } from '../env/env.ts';
import { GrantError } from '../errors.ts';
import { matchesSecret } from '../secrets.ts';

/** Only the environment's consumer, presenting `CONSUMER_TOKEN` as a bearer token, may exchange grants. */
export const requireConsumer = createMiddleware(async (c, next) => {
  const presented = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
  if (!(await matchesSecret(presented, useEnvironment().variables.CONSUMER_TOKEN)))
    throw new GrantError('invalid_token');
  await next();
});
