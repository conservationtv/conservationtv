import { buildCli } from '@conservationtv/agent-cli';
import { Client } from '@conservationtv/agent-sdk';
import { DeviceIdentity } from '@conservationtv/studio-sdk';
import { Cli } from 'incur';
import { activeProfile, identityOf, readCredentials, requireProfile } from '../credentials.js';
import { connectAgent, type ConnectOptions } from '../iroh.js';
import { useScope } from '../scope.js';

/** The identity an agent command calls as, and how it reaches the agent. */
interface Caller {
  identity: DeviceIdentity;
  options: ConnectOptions;
}

/**
 * Who to call as, and how to reach the agent: as the profile's device, on its studio's relay. A direct agent doesn't
 * check with the studio, so without a profile it is called as a new identity for this command alone.
 */
async function caller(direct: boolean): Promise<Caller> {
  const credentials = readCredentials();
  if (!direct) {
    const active = requireProfile(credentials);
    const identity = await identityOf(active.profile.device);
    return { identity, options: { direct, apiUrl: active.apiUrl } };
  }
  const active = activeProfile(credentials);
  if (active !== undefined) {
    const identity = await identityOf(active.profile.device);
    return { identity, options: { direct } };
  }
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  const identity = await DeviceIdentity.fromSecretKey(secretKey);
  return { identity, options: { direct } };
}

/** The agent API's generated commands, over HTTP over iroh to `--endpoint`, as the active profile's device. */
export const agentCommand = buildCli(
  Cli.create('agent', {
    description: "Call an agent over iroh: pass its endpoint id with --endpoint, and --direct for one on n0's defaults"
  }),
  async () => {
    const { globals, resources } = useScope();
    if (globals.endpoint === undefined) throw new Error("Pass --endpoint with the agent's endpoint id");
    const { identity, options } = await caller(globals.direct);
    const opened = await connectAgent(globals.endpoint, identity, options);
    // Closed when the command finishes: an open endpoint keeps the process alive.
    const connection = resources.use(opened);
    return new Client({ baseUrl: connection.baseUrl, fetch: connection.fetch });
  }
);
