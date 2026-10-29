import { createMiddleware } from 'hono/factory';
import { useEnvironment } from '../env/env.ts';
import { GrantError } from '../errors.ts';
import { withConsumer } from '../grants/consumer.ts';
import { matchesSecret } from '../secrets.ts';

/**
 * Only one of the environment's consumers, presenting its token from `CONSUMERS` as a bearer token, may exchange
 * grants. Every token is compared, so the time taken doesn't depend on which consumer matched.
 */
export const requireConsumer = createMiddleware(async (c, next) => {
  const environment = useEnvironment();
  const consumers = environment.variables.CONSUMERS;
  const authorization = c.req.header('authorization') ?? '';
  const presented = /^Bearer (.+)$/.exec(authorization)?.[1];
  const matches = await Promise.all(consumers.map(consumer => matchesSecret(presented, consumer.token)));
  const consumer = consumers.find((_, index) => matches[index]);
  if (consumer === undefined) throw new GrantError('invalid_token');
  await withConsumer({ namespace: consumer.namespace }, next);
});
