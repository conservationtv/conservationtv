import { chatName } from '@conservationtv/cameras';
import type { Camera, ChatCommand } from '@conservationtv/studio-sdk';
import { z } from 'zod';

import { cameraChatNamesOf } from '@/components/cameras/cameras';
import type { ChatAudience, ChatCommandSettingsInput } from '@/forms/schemas';
import { formatDuration } from '@/lib/format';

// What the studio knows about chat commands, in words: who may use one, what one does, and how it is typed in chat
// (apps/studio/api/src/chat/). A command that points a camera at a preset names both itself, or leaves either to the
// words that follow it in chat, the camera first: `!ptz pond feeder`. A command for the show the output follows takes
// everything from chat: two cameras to swap, each a position or a name (`!swap 1 fox`), or a stream to take over with,
// or `off` (`!takeover fox`).

/** An audience, and who is in it. Each takes in those above it: a moderator may use what a subscriber may. */
interface ChatAudienceDetails {
  audience: ChatAudience;
  label: string;
}

/** Who may use a command, least first. */
export const CHAT_AUDIENCES = [
  { audience: 'everyone', label: 'Everyone' },
  { audience: 'subscriber', label: 'Subscribers and above' },
  { audience: 'vip', label: 'VIPs and above' },
  { audience: 'moderator', label: 'Moderators and the broadcaster' },
  { audience: 'broadcaster', label: 'The broadcaster only' }
] as const satisfies readonly ChatAudienceDetails[];

/** What a command does, as a radio's value carries it, to be parsed back into one. */
export const ChatActionChoiceSchema = z.enum(['reply', 'cameraPreset', 'showSwap', 'showTakeover']);
export type ChatActionChoice = z.output<typeof ChatActionChoiceSchema>;

/** Who is in an audience, in words. */
export function chatAudienceLabelOf(audience: ChatAudience): string {
  return CHAT_AUDIENCES.find(candidate => candidate.audience === audience)?.label ?? audience;
}

/** What a camera is called on a page: its device's name. */
function cameraNameOf(camera: Camera): string {
  return camera.device?.name ?? 'Unnamed camera';
}

/** What a command does, in a line, with the camera it names by name. */
export function chatActionWordsOf(action: ChatCommand['action'], cameras: Camera[]): string {
  if (action.kind === 'reply') return `Says “${action.text}”`;
  if (action.kind === 'showSwap') return 'Swaps the two cameras named in chat, in the show its output follows';
  if (action.kind === 'showTakeover') return 'Takes over the show its output follows with the stream named in chat';
  const camera = cameras.find(candidate => candidate.id === action.cameraId);
  const cameraWords =
    action.cameraId === null ? 'the camera named in chat' : camera ? cameraNameOf(camera) : 'a camera that is gone';
  const presetWords = action.preset === null ? 'the preset named in chat' : `its preset “${action.preset}”`;
  return `Points ${cameraWords} at ${presetWords}`;
}

/** How long a command rests after it runs, in words. */
export function chatCooldownWordsOf(seconds: number): string {
  return seconds === 0 ? 'No rest between uses' : `Rests ${formatDuration(seconds)} after each use`;
}

/** A new command's form: a camera command taking both its words from chat, for moderators, resting five seconds. */
export const NEW_CHAT_COMMAND: ChatCommandSettingsInput = {
  name: '',
  audience: 'moderator',
  cooldownSeconds: '5',
  kind: 'cameraPreset',
  text: '',
  cameraId: '',
  presetSource: 'chat',
  preset: ''
};

/** A stored command as its form starts from it, both kinds' fields filled. */
export function chatCommandInputOf(command: ChatCommand): ChatCommandSettingsInput {
  const details = {
    name: command.name,
    audience: command.audience,
    cooldownSeconds: String(command.cooldownSeconds)
  };
  const { action } = command;
  if (action.kind === 'reply') {
    return { ...details, kind: 'reply', text: action.text, cameraId: '', presetSource: 'chat', preset: '' };
  }
  if (action.kind === 'showSwap' || action.kind === 'showTakeover') {
    return { ...details, kind: action.kind, text: '', cameraId: '', presetSource: 'chat', preset: '' };
  }
  return {
    ...details,
    kind: 'cameraPreset',
    text: '',
    cameraId: action.cameraId ?? '',
    presetSource: action.preset === null ? 'chat' : 'named',
    preset: action.preset ?? ''
  };
}

/**
 * How a command is typed in chat, given what its form has so far: its word, then whatever it leaves to chat, the
 * camera first, shown with one of the organisation's own cameras and presets where it has them.
 */
export function chatExampleOf(values: ChatCommandSettingsInput, cameras: Camera[]): string {
  const word = values.name.trim().replace(/^!/u, '').toLowerCase() || 'command';
  if (values.kind === 'reply') return `!${word}`;
  if (values.kind === 'showSwap') return `!${word} 1 ${exampleCameraWordOf(cameras[0])}`;
  if (values.kind === 'showTakeover') return `!${word} ${exampleCameraWordOf(cameras[0])}, or !${word} off`;
  const chosen = cameras.find(camera => camera.id === values.cameraId);
  // The camera the example goes on to name a preset of: the one chosen, or the one the example itself names.
  const camera = chosen ?? cameras[0];
  const words = [`!${word}`];
  if (!chosen) words.push(exampleCameraWordOf(camera));
  if (values.presetSource === 'chat') words.push(examplePresetWordOf(camera));
  return words.join(' ');
}

/** A word chat would find the camera by, for an example; a stand-in where there is no camera to name. */
function exampleCameraWordOf(camera: Camera | undefined): string {
  if (!camera) return 'camera';
  return cameraChatNamesOf(cameraNameOf(camera), camera.aliases)[0] ?? 'camera';
}

/** A word chat would find one of the camera's presets by, for an example; a stand-in where it has none. */
function examplePresetWordOf(camera: Camera | undefined): string {
  return chatName(camera?.presets[0]?.name ?? '') || 'preset';
}
