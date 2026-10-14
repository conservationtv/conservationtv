import {
  HttpError,
  HandshakeError,
  OperationVersionChangedError,
  OperationVersionUnavailableError,
  Client
} from '@conservationtv/studio-sdk';
import { Cli } from 'incur';
import { buildCli } from './generated/incur-builder.gen.js';
import { credentialsPath } from './credentials.js';
import { currentToken, login, LoginError, logout } from './login.js';

const apiUrl = process.env.STUDIO_API_URL ?? 'http://localhost:5175';

const cli = Cli.create('studio', {
  description: 'A generated version-aware client for the conservation.tv studio API',
  format: 'json'
});
cli.use(async (context, next) => {
  // Map every failure the SDK returns (and the generated commands throw) to a structured error and a failing exit code.
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
  }
});

// Sign-in is the OAuth device flow against the API's Better Auth routes; the token it stores authenticates the
// generated commands as a bearer token. STUDIO_TOKEN overrides the stored login for scripts and CI.
cli
  .command('login', {
    description: `Sign in: approve a code in the browser, then keep the session in ${credentialsPath()}`,
    run: ({ ok }) => login(apiUrl, message => console.error(message)).then(ok)
  })
  .command('logout', {
    description: 'Sign out of the API and forget the stored session',
    run: async ({ ok }) => ok({ api: apiUrl, signedOut: await logout(apiUrl) })
  });

await buildCli(cli, () => {
  const token = currentToken(apiUrl);
  return new Client({ baseUrl: apiUrl, headers: token ? { authorization: `Bearer ${token}` } : undefined });
}).serve();
