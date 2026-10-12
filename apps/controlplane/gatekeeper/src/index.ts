import app from './app.ts';
import { type PolicyConfig, PolicyConfigSchema } from './config/schemas.ts';
import { connectLazily } from './db/client.ts';
import { JwksCache } from './grants/jwks.ts';
import { purgeExpiredState } from './maintenance.ts';
import { loadMoqKeyring, type MoqKeyring } from './moq/keys.ts';
import { runWithServices, type Services } from './services.ts';

const CLOCK_SKEW_SECONDS = 30;

// Isolate-wide state: the validated policy, the JWKS cache and imported signing keys outlive individual requests.
const jwks = new JwksCache();
interface LoadedKeyring {
  secret: string;
  keys: Promise<MoqKeyring>;
}

let policy: PolicyConfig | undefined = undefined;
let keyring: LoadedKeyring | undefined = undefined;

/** An invalid registration fails every request rather than running with a partial policy. */
function loadPolicy(env: Env): PolicyConfig {
  if (policy == null) {
    policy = PolicyConfigSchema.parse({
      consumers: JSON.parse(env.CONSUMER_REGISTRATIONS),
      deniedIrohEndpoints: JSON.parse(env.DENIED_IROH_ENDPOINTS),
      maxCredentialLifetimeSeconds: Number(env.MAX_CREDENTIAL_LIFETIME_SECONDS),
      clockSkewSeconds: CLOCK_SKEW_SECONDS
    });
  }
  return policy;
}

function moqKeys(env: Env): Promise<MoqKeyring> {
  if (keyring?.secret !== env.MOQ_SIGNING_KEYS) {
    keyring = { secret: env.MOQ_SIGNING_KEYS, keys: loadMoqKeyring(env.MOQ_SIGNING_KEYS) };
  }
  return keyring.keys;
}

async function withServices<Result>(env: Env, ctx: ExecutionContext, task: () => Promise<Result>): Promise<Result> {
  const connection = connectLazily(env.HYPERDRIVE.connectionString);
  const active: Services = {
    policy: loadPolicy(env),
    database: connection.database,
    fetch: (input, init) => fetch(input, init),
    clock: Date.now,
    jwks,
    moqKeys: () => moqKeys(env),
    irohRelayToken: env.IROH_RELAY_TOKEN,
    moqRelayToken: env.MOQ_RELAY_TOKEN,
    moqClusterToken: env.MOQ_CLUSTER_TOKEN
  };
  try {
    return await runWithServices(active, task);
  } finally {
    ctx.waitUntil(connection.close());
  }
}

export default {
  fetch(request, env, ctx) {
    return withServices(env, ctx, async () => app.fetch(request));
  },
  async scheduled(_controller, env, ctx) {
    await withServices(env, ctx, async () => {
      // Find & purge any expired grants in the database
      await purgeExpiredState();
    });
  }
} satisfies ExportedHandler<Env>;
