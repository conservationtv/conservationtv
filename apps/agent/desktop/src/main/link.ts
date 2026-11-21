import { z } from 'zod';

// The link the studio's agent page opens to set this app up (apps/studio/web/src/components/agents/agent-setup.tsx):
//
//   ctvagent://setup?api=<studio API URL>&id=<agent id>&name=<agent name>&key=<secret key>
//
// The key is the agent's device's raw 32-byte Ed25519 seed, as unpadded base64url, as the studio API returns it. The
// link is the agent's identity, so whoever opens one is asked before it replaces anything (index.ts).

export const SCHEME = 'ctvagent';

const SetupSchema = z.object({
  api: z.url({ protocol: /^https?$/ }),
  id: z.string().min(1),
  name: z.string().min(1),
  key: z.string().refine(key => Buffer.from(key, 'base64url').length === 32, 'The key must be 32 bytes of base64url')
});
/** A setup link's query, as it is written. */
type Setup = z.output<typeof SetupSchema>;

/** An agent to run as, from a setup link. */
export interface SetupLink {
  apiUrl: string;
  id: string;
  name: string;
  secretKey: Uint8Array;
}

/** Whether a command-line argument is one of this app's links: Windows and Linux pass a link on the command line. */
export function isLink(argument: string): boolean {
  return argument.startsWith(`${SCHEME}:`);
}

/** The setup link `text` is, or an error saying why it is not one. */
export function parseLink(text: string): SetupLink | Error {
  const url = URL.parse(text);
  if (url === null) return new Error('The link is not a URL');
  if (url.protocol !== `${SCHEME}:`) return new Error(`The link is not a ${SCHEME}:// link`);
  if (url.hostname !== 'setup') return new Error(`This app does not know what to do with ${SCHEME}://${url.hostname}`);
  const parsed = SetupSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return new Error(`The link is missing something: ${z.prettifyError(parsed.error)}`);
  const { api, id, name, key }: Setup = parsed.data;
  return { apiUrl: api, id, name, secretKey: new Uint8Array(Buffer.from(key, 'base64url')) };
}
