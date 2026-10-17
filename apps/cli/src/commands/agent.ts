import { buildCli } from '@conservationtv/agent-cli';
import { Client } from '@conservationtv/agent-sdk';
import { DeviceIdentity } from '@conservationtv/studio-sdk';
import { Cli } from 'incur';
import { currentProfile, identityOf, readCredential, requireCredential } from '../credentials.js';
import { connectAgent } from '../iroh.js';
import { useScope } from '../scope.js';

/**
 * Who to call as: the current profile's device. A direct agent doesn't check with the studio, so without a login that
 * is a new identity for this command alone.
 */
function identity(direct: boolean): Promise<DeviceIdentity> {
  if (!direct) {
    const credential = requireCredential();
    return identityOf(currentProfile(credential).device);
  }
  const credential = readCredential();
  if (credential !== undefined) return identityOf(currentProfile(credential).device);
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  return DeviceIdentity.fromSecretKey(secretKey);
}

/** The agent API's generated commands, over HTTP over iroh to `--endpoint`, as the current profile's device. */
export const agentCommand = buildCli(
  Cli.create('agent', {
    description: "Call an agent over iroh: pass its endpoint id with --endpoint, and --direct for one on n0's defaults"
  }),
  async () => {
    const { globals, resources } = useScope();
    if (globals.endpoint === undefined) throw new Error("Pass --endpoint with the agent's endpoint id");
    const caller = await identity(globals.direct);
    const opened = await connectAgent(globals.endpoint, caller, { direct: globals.direct });
    // Closed when the command finishes: an open endpoint keeps the process alive.
    const connection = resources.use(opened);
    return new Client({ baseUrl: connection.baseUrl, fetch: connection.fetch });
  }
);
