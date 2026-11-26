import { STANDARD_WORDS } from '@conservationtv/chat';
import { z } from 'zod';

// What a command of the organisation's own is: a word viewers type after `!`, who may use it, and what it says. The
// cameras, the layout and the mix are controlled by the standard commands (`@conservationtv/chat`,
// src/chat/standard.ts), which every organisation has, so its own commands only reply. The agent an output runs on
// listens to the output's channels for both (apps/agent/core/src/output/chat), and tells this API each time one is used
// (`organisations.chatCommands.uses.create`); this API decides whether it runs, and what it does (src/chat/decide.ts).

/** The word a command is used by, after its `!`: lowercase letters, digits, `-` and `_`, and none a standard one's. */
export const ChatCommandNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/u, 'Lowercase letters, digits, `-` and `_`, at most 40')
  .refine(name => !STANDARD_WORDS.has(name), 'A standard command is used by that word')
  .describe('The word the command is used by, without its `!`: not one a standard command is used by.');
export type ChatCommandName = z.output<typeof ChatCommandNameSchema>;

/** Say something in chat. */
export const ReplyActionSchema = z
  .strictObject({ kind: z.literal('reply'), text: z.string().min(1).max(400) })
  .describe('What the command does: `reply`, saying `text` in chat.');
export type ReplyAction = z.output<typeof ReplyActionSchema>;

/** What a command does: it replies. */
export const ChatCommandActionSchema = ReplyActionSchema;
export type ChatCommandAction = z.output<typeof ChatCommandActionSchema>;
