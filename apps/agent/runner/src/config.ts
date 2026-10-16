import { arkenv } from '@arkenv/standard';
import { z } from 'zod';

/** The runner's settings, from the environment. An invalid environment fails at startup rather than serving. */
export const loadConfig = () =>
  arkenv({
    /** The agent's name, as it reports itself. */
    AGENT_NAME: z.string().min(1).default('agent'),
    /** The agent's ed25519 secret key as hex: its 32 bytes. `pnpm keygen` makes one. */
    AGENT_SECRET_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'AGENT_SECRET_KEY must be 32 bytes of hex')
      .transform(text => new Uint8Array(Buffer.from(text, 'hex'))),
    /** How long in-flight requests get to finish after a shutdown signal before the process exits anyway. */
    SHUTDOWN_DELAY_MS: z.coerce.number().int().positive().default(10_000)
  });

export type Config = ReturnType<typeof loadConfig>;
