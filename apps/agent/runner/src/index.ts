import { getDatabaseSink } from '@conservationtv/agent-api';
import { configure, dispose, getConsoleSink, getJsonLinesFormatter, getLogger } from '@logtape/logtape';
import closeWithGrace from 'close-with-grace';
import { createEnvironment } from './env/env.ts';

// The environment first: it opens the agent's database, which keeps its logs.
const environment = createEnvironment();

// Every line is one JSON object, info and below on stdout and warnings and errors on stderr, which the container
// collects. Its message is the template, the same for every line of its kind, beside the values as fields. Each line
// is also kept in the agent's database, to read over the agent API. Another transport is another sink here; the
// agent's modules only ask for loggers.
const formatter = getJsonLinesFormatter({ message: 'template', properties: 'flatten' });
await configure({
  sinks: { console: getConsoleSink({ formatter }), database: getDatabaseSink(environment.database) },
  loggers: [
    { category: 'agent', lowestLevel: 'info', sinks: ['console', 'database'] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] }
  ]
});
const logger = getLogger(['agent', 'runner']);

// A signal, an uncaught error or an unhandled rejection all stop the agent once. A second signal, or the delay
// running out, exits immediately; an error exits non-zero.
closeWithGrace({ delay: environment.variables.SHUTDOWN_DELAY_MS }, async ({ signal, err }) => {
  if (err) logger.fatal('Stopping after {error}', { error: err });
  else logger.info('Stopping on {signal}', { signal: signal ?? null });
  await environment.agent.stop();
  await dispose();
  environment.database.$client.close();
});

await environment.agent.start();
