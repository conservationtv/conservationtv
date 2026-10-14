import type { Principal } from '@conservationtv/umbrella';
import { authorization } from './access.ts';
import app from './app.ts';
import { createAuth, type Auth } from './auth/auth.ts';
import { otpDelivery } from './auth/otp.ts';
import { connectLazily } from './db/client.ts';
import { ConfigSchema, runWithServices, type Config, type Services } from './services.ts';

// Isolate-wide state: the validated configuration outlives individual requests.
let config: Config | undefined = undefined;

/** An invalid deployment fails every request rather than running with a partial configuration. */
function loadConfig(env: Env): Config {
  if (config == null) {
    config = ConfigSchema.parse({
      appUrl: env.APP_URL,
      webOrigins: env.WEB_ORIGINS.split(',')
        .map(origin => origin.trim())
        .filter(Boolean),
      otpDelivery: env.OTP_DELIVERY,
      authSecret: env.BETTER_AUTH_SECRET
    });
  }
  return config;
}

/** Memoize a per-request client so its connection opens at most once. */
function once<Value>(create: () => Promise<Value>): () => Promise<Value> {
  let pending: Promise<Value> | undefined = undefined;
  return () => {
    if (pending == null) pending = create();
    return pending;
  };
}

async function withServices<Result>(env: Env, ctx: ExecutionContext, task: () => Promise<Result>): Promise<Result> {
  const admin = connectLazily(env.HYPERDRIVE_ADMIN.connectionString);
  const application = connectLazily(env.HYPERDRIVE_APP.connectionString);
  const settings = loadConfig(env);
  const background = (task: Promise<unknown>) => ctx.waitUntil(task);
  const auth = once(async (): Promise<Auth> => {
    const database = await admin.database();
    return createAuth({
      database,
      access: authorization.access(database),
      config: settings,
      deliverOtp: otpDelivery(settings.otpDelivery),
      background
    });
  });
  const active: Services = {
    config: settings,
    clock: Date.now,
    background,
    admin: admin.database,
    app: application.database,
    session: async (principal: Principal) => authorization.as(await application.database(), principal),
    auth
  };
  try {
    return await runWithServices(active, task);
  } finally {
    ctx.waitUntil(Promise.all([admin.close(), application.close()]));
  }
}

export default {
  fetch(request, env, ctx) {
    return withServices(env, ctx, async () => app.fetch(request));
  }
} satisfies ExportedHandler<Env>;
