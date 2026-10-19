import { arkenv } from '@arkenv/standard';
import { Agent } from '@conservationtv/agent-api';
import { resolve } from 'node:path';
import { z } from 'zod';

/** The runner's settings, from the environment. */
export const config = {
  /** The agent's name, as it reports itself. */
  AGENT_NAME: z.string().min(1).default('agent'),
  /**
   * `conservationtv`: an agent of an organisation, whose sessions come from the studio API at `STUDIO_API_URL`.
   * `direct`: an agent on its own, on n0's public relays and address lookup, that never calls the studio API.
   */
  AGENT_MODE: z.enum(['conservationtv', 'direct']).default('conservationtv'),
  /** For `conservationtv`: the studio API. */
  STUDIO_API_URL: z.url().optional(),
  /**
   * The agent's secret key as hex: its 32-byte Ed25519 seed. For `conservationtv`, its device's in the studio; for
   * `direct`, any (`pnpm keygen` makes one).
   */
  AGENT_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'AGENT_SECRET_KEY must be 32 bytes of hex')
    .transform(text => new Uint8Array(Buffer.from(text, 'hex'))),
  /** Where the agent keeps what its runtimes run, such as MediaMTX's binaries, config and log. Relative to the cwd. */
  AGENT_DATA_DIR: z
    .string()
    .min(1)
    .default('data')
    .transform(path => resolve(path)),
  /** How long in-flight requests get to finish after a shutdown signal before the process exits anyway. */
  SHUTDOWN_DELAY_MS: z.coerce.number().int().positive().default(10_000)
};

export type Variables = ReturnType<typeof arkenv<typeof config>>;

export const services = (variables: Variables) => {
  /*
    This is where we initialise all clients that use some configuration from the environment.
    This is useful because we can fail fast, not initialise clients that are not needed and
    ensure we make only one client for each service.
  */

  // Required clients
  const agent = (() => {
    const name = variables.AGENT_NAME;
    const secretKey = variables.AGENT_SECRET_KEY;
    const directory = variables.AGENT_DATA_DIR;
    if (variables.AGENT_MODE === 'direct') {
      return new Agent({ type: 'direct', name, secretKey, directory });
    }

    if (variables.STUDIO_API_URL === undefined) {
      throw new Error('AGENT_MODE=conservationtv needs STUDIO_API_URL');
    }

    return new Agent({
      type: 'conservationtv',
      name,
      secretKey,
      directory,
      studioUrl: variables.STUDIO_API_URL
    });
  })();

  return {
    agent
  };
};
