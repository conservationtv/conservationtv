import { z } from 'zod';

// Who may use a chat command. The studio API decides it, and the agent that listens to chat decides it first too, so a
// use by someone outside the audience is never told to the studio API: both read it from here, so they cannot drift.

/**
 * Who may use a command, each including those after it: `everyone` in chat, the channel's `subscriber`s, its `vip`s,
 * its `moderator`s, or only its `broadcaster`.
 */
export const CHAT_AUDIENCES = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'] as const;
export const ChatAudienceSchema = z
  .enum(CHAT_AUDIENCES)
  .describe(
    'Who may use the command: `everyone`, or only those who are at least a `subscriber`, a `vip`, a `moderator` or the `broadcaster`.'
  );
export type ChatAudience = z.output<typeof ChatAudienceSchema>;

/** Whether someone who is these things in a channel is in the audience: being any one of them, or more, is enough. */
export function inAudience(audience: ChatAudience, roles: readonly ChatAudience[]): boolean {
  const needed = CHAT_AUDIENCES.indexOf(audience);
  return needed === 0 || roles.some(role => CHAT_AUDIENCES.indexOf(role) >= needed);
}
