import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arkenv } from '@arkenv/standard';
import { Agent, PeersSchema, openDatabase } from '@conservationtv/agent-api';
import { z } from 'zod';
import { CHECKOUT_MIGRATIONS } from '../migrations.ts';

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
  /**
   * A directory of the agent's own, where it keeps everything that outlives it: what its runtimes install and run, and
   * its database of samples and logs.
   */
  AGENT_DATA_DIR: z.string().min(1).default('data'),
  /** The database's migrations; the core's own in a checkout. */
  AGENT_MIGRATIONS_DIR: z.string().min(1).default(CHECKOUT_MIGRATIONS),
  /** How many days of samples and logs the agent keeps; 14 by default. */
  AGENT_RETENTION_DAYS: z.coerce.number().positive().optional(),
  /** How many megabytes of samples and logs the agent keeps, dropping the oldest beyond; 1024 by default. */
  AGENT_RETENTION_MB: z.coerce.number().positive().optional(),
  /**
   * A JSON file listing the peers the agent serves, `[{ endpointId, allow: { relayed, direct } }]`: whether each may
   * connect directly, learning the agent's IP addresses, or only through the relay. Without it, every peer is served
   * and may connect directly.
   */
  AGENT_PEERS_FILE: z.string().min(1).optional(),
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
  const directory = resolve(variables.AGENT_DATA_DIR);
  const database = openDatabase({ directory, migrations: resolve(variables.AGENT_MIGRATIONS_DIR) });

  const agent = (() => {
    const name = variables.AGENT_NAME;
    const secretKey = variables.AGENT_SECRET_KEY;
    // Each retention limit left unset is the agent's default; the mode picks the configuration's kind.
    const retention = {
      maxAgeMs: variables.AGENT_RETENTION_DAYS === undefined ? undefined : variables.AGENT_RETENTION_DAYS * 86_400_000,
      maxBytes: variables.AGENT_RETENTION_MB === undefined ? undefined : variables.AGENT_RETENTION_MB * 1024 * 1024
    };
    const peers = (() => {
      const file = variables.AGENT_PEERS_FILE;
      if (file === undefined) return undefined;
      const text = readFileSync(file, 'utf8');
      const json: unknown = JSON.parse(text);
      return PeersSchema.parse(json);
    })();
    if (variables.AGENT_MODE === 'direct') {
      return new Agent({ type: 'direct', name, secretKey, directory, peers, retention }, database);
    }

    if (variables.STUDIO_API_URL === undefined) {
      throw new Error('AGENT_MODE=conservationtv needs STUDIO_API_URL');
    }

    return new Agent(
      {
        type: 'conservationtv',
        name,
        secretKey,
        directory,
        peers,
        retention,
        studioUrl: variables.STUDIO_API_URL
      },
      database
    );
  })();

  return {
    database,
    agent
  };
};
