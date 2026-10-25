import { configure, dispose, getConsoleSink, getJsonLinesFormatter, getLogger } from '@logtape/logtape';
import closeWithGrace from 'close-with-grace';
import { createEnvironment } from './env/env.ts';

// Every line is one JSON object, info and below on stdout and warnings and errors on stderr, which the container
// collects. Its message is the template, the same for every line of its kind, beside the values as fields. Another
// transport is another sink here; the agent's modules only ask for loggers.
const formatter = getJsonLinesFormatter({ message: 'template', properties: 'flatten' });
await configure({
  sinks: { console: getConsoleSink({ formatter }) },
  loggers: [
    { category: 'agent', lowestLevel: 'info', sinks: ['console'] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] }
  ]
});
const logger = getLogger(['agent', 'runner']);

const environment = createEnvironment();

// A signal, an uncaught error or an unhandled rejection all stop the agent once. A second signal, or the delay
// running out, exits immediately; an error exits non-zero.
closeWithGrace({ delay: environment.variables.SHUTDOWN_DELAY_MS }, async ({ signal, err }) => {
  if (err) logger.fatal('Stopping after {error}', { error: err });
  else logger.info('Stopping on {signal}', { signal: signal ?? null });
  await environment.agent.stop();
  await dispose();
});

await environment.agent.start();
