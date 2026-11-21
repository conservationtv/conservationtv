import { z } from 'zod';

// What a chat command is: a word viewers type after `!`, who may use it, and the one thing it does. The agent an
// output runs on listens to the output's channels for the words (apps/agent/core/src/output/chat), and tells this API
// each time one is used (`organisations.chatCommands.trigger`); this API decides whether it runs, and what it does
// (src/chat/decide.ts). Who may use one is shared with that agent, in `@conservationtv/chat`.

/** The word a command is used by, after its `!`: lowercase letters, digits, `-` and `_`. */
export const ChatCommandNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/u, 'Lowercase letters, digits, `-` and `_`, at most 40')
  .describe('The word the command is used by, without its `!`.');
export type ChatCommandName = z.output<typeof ChatCommandNameSchema>;

/** Say something in chat. */
const ReplyActionSchema = z.strictObject({ kind: z.literal('reply'), text: z.string().min(1).max(400) });
export type ReplyAction = z.output<typeof ReplyActionSchema>;

/**
 * Point a camera at one of its presets. A `cameraId` or `preset` left null is taken from what follows the command in
 * chat, the camera first: `!ptzhome pond` with the preset fixed as `home`, or `!ptz pond feeder` with neither fixed.
 */
const CameraPresetActionSchema = z.strictObject({
  kind: z.literal('cameraPreset'),
  cameraId: z.uuid().nullable(),
  preset: z.string().min(1).max(60).nullable()
});
export type CameraPresetAction = z.output<typeof CameraPresetActionSchema>;

export const ChatCommandActionSchema = z
  .discriminatedUnion('kind', [ReplyActionSchema, CameraPresetActionSchema])
  .describe(
    'What the command does, by `kind`: `reply` with `text`, or `cameraPreset`, pointing a camera at one of its presets, each named by the command or, when null, by the words that follow it in chat, the camera first.'
  );
export type ChatCommandAction = z.output<typeof ChatCommandActionSchema>;
