import { buildCli as buildAgentCli } from '@conservationtv/agent-cli';
import { Client as AgentClient } from '@conservationtv/agent-sdk';
import { buildCli as buildStudioCli } from '@conservationtv/studio-cli';
import {
  Client as StudioClient,
  HandshakeError,
  HttpError,
  OperationVersionChangedError,
  OperationVersionUnavailableError
} from '@conservationtv/studio-sdk';
import { Cli } from 'incur';
import { z } from 'zod';
import { connectAgent, type AgentConnection } from './agent/iroh.js';
import { credentialsPath, currentProfile, readCredential, secretKeyOf } from './auth/credentials.js';
import { currentToken, login, LoginError, logout } from './auth/login.js';
import { profilesCommand } from './auth/profiles.js';

// The studio API that signs in, registers each profile's device, and serves the top-level commands.
const apiUrl = process.env.STUDIO_API_URL ?? 'http://localhost:5175';

// The agent connection, opened by the first `agent` command that needs it and closed once that command finishes.
let connection: AgentConnection | undefined = undefined;

const cli = Cli.create('ctv', {
  description: 'The conservation.tv CLI: the studio API, and agents over iroh',
  format: 'json',
  // Global so it parses wherever it appears, but only `agent` commands read it.
  globals: z.object({
    endpoint: z.string().optional().describe('For `agent` commands: the iroh endpoint id of the agent to call')
  })
});

// The endpoint `agent` commands dial, from the parsed globals.
let endpoint: string | undefined = undefined;

cli.use(async (context, next) => {
  endpoint = context.globals.endpoint;
  // Map every failure the SDKs return (and the generated commands throw) to a structured error and a failing exit
  // code. Both SDKs share these classes through @conservationtv/versioned-api.
  try {
    await next();
  } catch (error) {
    // Most specific first: version negotiation, then handshake, then HTTP status, then login, then any other Error.
    if (error instanceof OperationVersionUnavailableError || error instanceof OperationVersionChangedError) {
      return context.error({ code: 'OPERATION_VERSION_UNAVAILABLE', message: error.message });
    }
    if (error instanceof HandshakeError) return context.error({ code: 'HANDSHAKE_FAILED', message: error.message });
    if (error instanceof HttpError) return context.error({ code: error.code ?? error.name, message: error.message });
    if (error instanceof LoginError) return context.error({ code: 'LOGIN_FAILED', message: error.message });
    if (error instanceof Error) return context.error({ code: 'REQUEST_FAILED', message: error.message });
    throw error;
  } finally {
    // An open endpoint keeps the process alive.
    await connection?.close();
  }
});

// Sign-in is the OAuth device flow against the studio API's Better Auth routes, then the session's browser device in
// an organisation you pick: your first profile. The stored token authenticates the studio commands as a bearer token
// (STUDIO_TOKEN overrides it for scripts and CI); the current profile's device is the identity agents see.
cli
  .command('login', {
    description: `Sign in: approve a code in the browser, pick an organisation, and keep both in ${credentialsPath()}`,
    options: z.object({
      organisation: z
        .string()
        .optional()
        .describe('The organisation to start in, by id or name; asked for when omitted')
    }),
    run: ({ options, ok }) => login(apiUrl, options.organisation, message => console.error(message)).then(ok)
  })
  .command('logout', {
    description: "Sign out of the API, which removes every profile's device, and forget the stored login",
    run: async ({ ok }) => ok({ api: apiUrl, signedOut: await logout(apiUrl) })
  })
  .command(profilesCommand(apiUrl));

// The studio API's generated commands, at the top level.
buildStudioCli(cli, () => {
  const token = currentToken(apiUrl);
  return new StudioClient({ baseUrl: apiUrl, headers: token ? { authorization: `Bearer ${token}` } : undefined });
});

// The agent API's generated commands, over HTTP over iroh to `--endpoint`, as the current profile's device.
const agent = Cli.create('agent', { description: 'Call an agent over iroh: pass its endpoint id with --endpoint' });
buildAgentCli(agent, async () => {
  if (endpoint === undefined) throw new Error("Pass --endpoint with the agent's endpoint id");
  const credential = readCredential(apiUrl);
  if (credential === undefined) throw new LoginError('Run `ctv login` first.');
  const profile = currentProfile(credential);
  const secretKey = secretKeyOf(profile.device);
  connection = await connectAgent(endpoint, secretKey);
  return new AgentClient({ baseUrl: connection.baseUrl, fetch: connection.fetch });
});
cli.command(agent);

await cli.serve();
