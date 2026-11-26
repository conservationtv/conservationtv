import type { StandardGroup } from '@conservationtv/chat';
import type { ChatCommand } from '@conservationtv/studio-sdk';

import type { ChatAudience, ChatCommandSettingsInput, StandardChatCommandSettingsInput } from '@/forms/schemas';
import type { StandardChatCommand } from '@/queries/chat-commands';
import { formatDuration } from '@/lib/format';

// What the studio knows about chat commands, in words (apps/studio/api/src/chat/): who may use one, how long one
// rests, and the groups the standard commands are listed in. An organisation's own commands each say something; the
// standard ones (@conservationtv/chat) point and move cameras, change the show's layout, and set its sound.

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

/** Who is in an audience, in words. */
export function chatAudienceLabelOf(audience: ChatAudience): string {
  return CHAT_AUDIENCES.find(candidate => candidate.audience === audience)?.label ?? audience;
}

/** How long a command rests after it runs, in words. */
export function chatCooldownWordsOf(seconds: number): string {
  return seconds === 0 ? 'No rest between uses' : `Rests ${formatDuration(seconds)} after each use`;
}

/** A group of standard commands, with its heading and what its commands act on. */
interface StandardGroupDetails {
  group: StandardGroup;
  title: string;
  description: string;
}

/** The groups the standard commands are listed in, in order. */
export const STANDARD_CHAT_GROUPS = [
  {
    group: 'camera',
    title: 'Camera',
    description:
      'Each names a camera first: its name, one of its aliases, or its position in the lineup of the show the output follows (1 is the largest slot). They rest per camera, so moving one camera never holds up another.'
  },
  {
    group: 'layout',
    title: 'Layout',
    description: 'For the show the output follows: which cameras are where. They rest per show.'
  },
  {
    group: 'audio',
    title: 'Audio',
    description: 'For the show the output follows: each camera’s sound, and the mix. They rest per show.'
  }
] as const satisfies readonly StandardGroupDetails[];

/** A new command's form: for everyone, resting thirty seconds, so a reply can't flood chat. */
export const NEW_CHAT_COMMAND: ChatCommandSettingsInput = {
  name: '',
  audience: 'everyone',
  cooldownSeconds: '30',
  text: ''
};

/** A stored command as its form starts from it. */
export function chatCommandInputOf(command: ChatCommand): ChatCommandSettingsInput {
  return {
    name: command.name,
    audience: command.audience,
    cooldownSeconds: String(command.cooldownSeconds),
    text: command.action.text
  };
}

/** A standard command as its form starts from it: who may use it and how long it rests, as it is now. */
export function standardChatCommandInputOf(command: StandardChatCommand): StandardChatCommandSettingsInput {
  return { audience: command.audience, cooldownSeconds: String(command.cooldownSeconds) };
}
