import {
  bearer,
  HttpError,
  HandshakeError,
  OperationVersionChangedError,
  OperationVersionUnavailableError,
  Client
} from '@conservationtv/controlplane-sdk';
import { Cli } from 'incur';
import { buildCli } from './generated/incur-builder.gen.js';

const cli = Cli.create('gatekeeper', {
  description: 'A generated version-aware client for the conservation.stream control plane',
  format: 'json'
});
cli.use(async (context, next) => {
  // Map every failure the SDK returns (and the generated commands throw) to a structured error and a failing exit code.
  try {
    await next();
  } catch (error) {
    // Most specific first: version negotiation, then handshake, then HTTP status, then any other Error.
    if (error instanceof OperationVersionUnavailableError || error instanceof OperationVersionChangedError) {
      return context.error({ code: 'OPERATION_VERSION_UNAVAILABLE', message: error.message });
    }
    if (error instanceof HandshakeError) return context.error({ code: 'HANDSHAKE_FAILED', message: error.message });
    if (error instanceof HttpError) return context.error({ code: error.code ?? error.name, message: error.message });
    if (error instanceof Error) return context.error({ code: 'REQUEST_FAILED', message: error.message });
    throw error;
  }
});
// GATEKEEPER_TOKEN is the environment's consumer token, which `grants exchange` requires.
const token = process.env.GATEKEEPER_TOKEN;
const client = () =>
  new Client({
    baseUrl: process.env.GATEKEEPER_URL ?? 'http://localhost:5176',
    auth: token === undefined ? undefined : bearer(token)
  });
await buildCli(cli, client).serve();
