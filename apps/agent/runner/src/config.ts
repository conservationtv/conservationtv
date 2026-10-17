import { arkenv } from '@arkenv/standard';
import { RelaySchema, type AgentConfiguration, type IrohSession } from '@conservationtv/agent-api';
import { z } from 'zod';

/** The runner's settings, from the environment. An invalid environment fails at startup rather than serving. */
export const loadConfig = () =>
  arkenv({
    /** The agent's name, as it reports itself. */
    AGENT_NAME: z.string().min(1).default('agent'),
    /**
     * `conservationtv`: an agent of an organisation, whose sessions come from the studio API at `STUDIO_API_URL`.
     * `direct`: an agent on its own, using `AGENT_RELAYS`, that never calls the studio API.
     */
    AGENT_MODE: z.enum(['conservationtv', 'direct']).default('conservationtv'),
    /** For `conservationtv`: the studio API. */
    STUDIO_API_URL: z.url().optional(),
    /** For `direct`: `n0`, or a JSON list of relays, each `{ "url": …, "quicPort"?: …, "authToken"?: … }`. */
    AGENT_RELAYS: z.string().default('n0'),
    /**
     * The agent's secret key as hex: its 32-byte Ed25519 seed. For `conservationtv`, its device's in the studio; for
     * `direct`, any (`pnpm keygen` makes one).
     */
    AGENT_SECRET_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'AGENT_SECRET_KEY must be 32 bytes of hex')
      .transform(text => new Uint8Array(Buffer.from(text, 'hex'))),
    /** How long in-flight requests get to finish after a shutdown signal before the process exits anyway. */
    SHUTDOWN_DELAY_MS: z.coerce.number().int().positive().default(10_000)
  });

export type Config = ReturnType<typeof loadConfig>;

/** `AGENT_RELAYS` as the session the studio API would have returned, checked against the API's own schema. */
function directSession(setting: string): IrohSession {
  if (setting === 'n0') return { relays: { type: 'n0' } };
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(setting);
  } catch (cause) {
    throw new Error('AGENT_RELAYS must be `n0` or a JSON list of relays', { cause });
  }
  const relays = z.array(RelaySchema).safeParse(parsed);
  if (!relays.success) throw new Error(`AGENT_RELAYS is not a list of relays:\n${z.prettifyError(relays.error)}`);
  return { relays: { type: 'custom', relays: relays.data } };
}

/** The agent's configuration for the mode the environment chose. */
export function agentConfiguration(config: Config): AgentConfiguration {
  const name = config.AGENT_NAME;
  const secretKey = config.AGENT_SECRET_KEY;
  if (config.AGENT_MODE === 'direct')
    return { type: 'direct', name, secretKey, session: directSession(config.AGENT_RELAYS) };
  if (config.STUDIO_API_URL === undefined) throw new Error('AGENT_MODE=conservationtv needs STUDIO_API_URL');
  return { type: 'conservationtv', name, secretKey, studioUrl: config.STUDIO_API_URL };
}
