import { z } from 'zod';

// What one use of a chat command comes to, in the words the studio API and the listening agent both speak. The agent
// tells the studio API a command was used (`organisations.chatCommands.uses.create`), and is told one of these
// statuses:
//
//   notRun    nothing ran, for one of the reasons below; the command's turn was not spent by this use
//   ran       it ran, and finished in the studio API: a reply said in chat there, or a change to the show
//   planned   it ran, and the agent has camera commands to carry out; the reply waits for what came of them
//
// A planned use is settled (`organisations.chatCommands.uses.settle`) with what came of carrying it out, one of the
// results below, and only then is chat told.

/** What a use came to: see above. */
export const CHAT_COMMAND_STATUSES = ['notRun', 'ran', 'planned'] as const;
export type ChatCommandStatus = (typeof CHAT_COMMAND_STATUSES)[number];

/**
 * Why a use didn't run: the command is `disabled` or gone, the viewer is not in its `audience`, it is `resting` in its
 * cooldown, its words name no camera or preset it can use (`unresolved`), or nothing can move the camera now
 * (`unavailable`).
 */
export const CHAT_COMMAND_REASONS = ['disabled', 'audience', 'resting', 'unresolved', 'unavailable'] as const;
export const ChatCommandReasonSchema = z
  .enum(CHAT_COMMAND_REASONS)
  .describe(
    'Why it did not run: the command is `disabled` or gone, the viewer is not in its `audience`, it is `resting` in its cooldown, its words name no camera or preset it can use (`unresolved`), or nothing can move the camera now (`unavailable`).'
  );
export type ChatCommandReason = z.output<typeof ChatCommandReasonSchema>;

/**
 * What came of carrying out a planned use's camera commands, as the agent that carried them says: they were `carried`
 * and the camera took them; or the camera was `held` (someone is at its controls), the agent that reaches it was
 * `unreachable`, it `refused` the grant, or the camera `failed` to take the command.
 */
export const CARRY_RESULTS = ['carried', 'held', 'unreachable', 'refused', 'failed'] as const;
export const CarryResultSchema = z
  .enum(CARRY_RESULTS)
  .describe(
    'What came of carrying the camera commands out: `carried`, and the camera took them; or the camera was `held` by someone at its controls, the agent that reaches it was `unreachable`, it `refused` the grant, or the camera `failed` to take the command.'
  );
export type CarryResult = z.output<typeof CarryResultSchema>;
