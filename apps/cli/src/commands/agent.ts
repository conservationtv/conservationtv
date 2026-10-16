import { buildCli } from '@conservationtv/agent-cli';
import { Client } from '@conservationtv/agent-sdk';
import { Cli } from 'incur';
import { currentProfile, requireCredential, secretKeyOf } from '../credentials.js';
import { connectAgent } from '../iroh.js';
import { useScope } from '../scope.js';

/** The agent API's generated commands, over HTTP over iroh to `--endpoint`, as the current profile's device. */
export const agentCommand = buildCli(
  Cli.create('agent', { description: 'Call an agent over iroh: pass its endpoint id with --endpoint' }),
  async () => {
    const { globals, resources } = useScope();
    if (globals.endpoint === undefined) throw new Error("Pass --endpoint with the agent's endpoint id");
    const credential = requireCredential();
    const profile = currentProfile(credential);
    const secretKey = secretKeyOf(profile.device);
    const opened = await connectAgent(globals.endpoint, secretKey);
    // Closed when the command finishes: an open endpoint keeps the process alive.
    const connection = resources.use(opened);
    return new Client({ baseUrl: connection.baseUrl, fetch: connection.fetch });
  }
);
