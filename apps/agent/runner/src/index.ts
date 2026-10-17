import { Agent } from '@conservationtv/agent-api';
import closeWithGrace from 'close-with-grace';
import { agentConfiguration, loadConfig } from './config.ts';

const config = loadConfig();
const agent = new Agent(agentConfiguration(config));

// A signal, an uncaught error or an unhandled rejection all stop the agent once. A second signal, or the delay
// running out, exits immediately; an error exits non-zero.
closeWithGrace({ delay: config.SHUTDOWN_DELAY_MS }, async ({ signal, err }) => {
  if (err) console.error(err);
  console.log(JSON.stringify({ event: 'stopping', signal: signal ?? null, error: err ? String(err) : null }));
  await agent.stop();
});

await agent.start();
