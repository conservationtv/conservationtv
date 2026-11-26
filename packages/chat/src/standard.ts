import { z } from 'zod';
import type { ChatAudience } from './audiences.ts';

// The standard chat commands: the camera, layout and audio commands every organisation has, for every camera, with
// nothing to register. They follow Alveus Sanctuary's documented commands (alveussanctuary.org/commands) wherever this
// system has what they act on, by the same words and the same aliases, so a viewer who knows one knows the other.
//
// Each is used by its `name` or any of its `aliases`. An organisation can switch one off, or change who may use it and
// how long it rests (`chat_command_setting`); otherwise it is as below. A camera command rests per camera, and a layout
// or audio command per show (its `target`), so moving one camera never holds up another.
//
// Where a word names a camera, it is the camera's name or one of its aliases, or a position in the lineup of the show
// the output follows (`1` is the largest slot). Zoom and focus are percentages: an absolute one from 0 (widest,
// nearest) to 100, and a relative zoom as Alveus has it, around 100 (`!ptzzoom pond 150` zooms in by half the camera's
// range, `50` out by half). Volumes are percentages of standard volume, 100 being standard.

/** What a standard command acts on, which its rest is counted per: a camera, or the show the output follows. */
export const STANDARD_TARGETS = ['camera', 'show'] as const;
export type StandardTarget = (typeof STANDARD_TARGETS)[number];

/** The groups the standard commands are listed in. */
export const STANDARD_GROUPS = ['camera', 'layout', 'audio'] as const;
export type StandardGroup = (typeof STANDARD_GROUPS)[number];

/** One standard command, as it is when its organisation hasn't changed it. */
export interface StandardCommand {
  name: string;
  aliases: readonly string[];
  group: StandardGroup;
  target: StandardTarget;
  /** How it is used, after its `!`: `<required>`, `[optional]`, `a|b` either. */
  usage: string;
  description: string;
  audience: ChatAudience;
  cooldownSeconds: number;
}

/** A standard command whose name is known: so the catalogue's names are a closed vocabulary. */
interface Named<Name extends string> extends StandardCommand {
  name: Name;
}

const camera = <Name extends string>(
  name: Name,
  usage: string,
  description: string,
  audience: ChatAudience = 'moderator',
  aliases: readonly string[] = []
): Named<Name> => ({
  name,
  aliases,
  group: 'camera',
  target: 'camera',
  usage: `${name} ${usage}`.trim(),
  description,
  audience,
  cooldownSeconds: 5
});

const show = <Name extends string>(
  group: 'layout' | 'audio',
  name: Name,
  usage: string,
  description: string,
  audience: ChatAudience = 'moderator',
  aliases: readonly string[] = []
): Named<Name> => ({
  name,
  aliases,
  group,
  target: 'show',
  usage: `${name} ${usage}`.trim(),
  description,
  audience,
  cooldownSeconds: 5
});

export const STANDARD_COMMANDS = [
  // Presets: anyone subscribed may load them, as at Alveus.
  camera('ptzhome', '<camera>', 'Point the camera at its `home` preset.', 'subscriber'),
  camera('ptzload', '<camera> <preset>', 'Point the camera at one of its presets.', 'subscriber'),
  camera('ptzlist', '<camera>', "List the camera's presets.", 'subscriber'),
  // Moves.
  camera('ptzpan', '<camera> <degrees>', 'Pan the camera by that many degrees: positive is to the right.'),
  camera('ptztilt', '<camera> <degrees>', 'Tilt the camera by that many degrees: positive is upwards.'),
  camera('ptzzoom', '<camera> <zoom>', 'Zoom the camera: above 100 zooms in, below 100 zooms out.'),
  camera('ptzset', '<camera> <pan> <tilt> <zoom>', 'Pan and tilt by degrees, and zoom as `ptzzoom` does, together.'),
  camera(
    'ptzseta',
    '<camera> <pan> <tilt> <zoom> [focus]',
    'Point the camera at a pan and tilt in degrees, a zoom from 0 to 100, and a focus from 0 to 100.'
  ),
  camera(
    'ptzmove',
    '<camera> <up|down|left|right|upleft|upright|downleft|downright>',
    'Move the camera a step in that direction.'
  ),
  camera(
    'ptzcenter',
    '<camera> <x> <y> [zoom]',
    'Centre the camera on a point of its picture, from 0 to 100 across and down, zooming as `ptzzoom` does.'
  ),
  camera('ptzfocusa', '<camera> <focus>', 'Focus the camera, from 0 (nearest) to 100.'),
  // The layout.
  show('layout', 'swap', '<camera|position> <camera|position>', 'Swap two cameras in the layout, by name or position.'),
  show('layout', 'slots', '<0-6>', 'Set how many slots the layout has: 1 is one camera, 6 the most.'),
  show('layout', 'scenecams', '', 'List the cameras on screen, by position.', 'subscriber'),
  show('layout', 'takeover', '<stream|off>', 'Put one stream on screen on its own, or `off` to go back to the layout.'),
  show('layout', 'livecams', '', 'End a takeover: back to the layout.'),
  // The mix.
  show('audio', 'mute', '<camera|all>', "Mute a camera's sound, or every camera's."),
  show('audio', 'unmute', '<camera|all>', "Unmute a camera's sound, or every camera's and the show's."),
  show('audio', 'setvolume', '<camera> <volume>', "Set a camera's volume: 100 is standard, 0 the quietest."),
  show('audio', 'getvolume', '<camera|all>', "Say a camera's volume, or every camera's.", 'subscriber'),
  show('audio', 'resetvolume', '', 'Put every camera back to standard volume, unmuted.')
] as const satisfies readonly StandardCommand[];

/** The name of a command in the catalogue. */
type CatalogueName = (typeof STANDARD_COMMANDS)[number]['name'];

const [FIRST_COMMAND, ...OTHER_COMMANDS] = STANDARD_COMMANDS;

/** Every standard command's name, in the catalogue's order. */
export const STANDARD_COMMAND_NAMES: [CatalogueName, ...CatalogueName[]] = [
  FIRST_COMMAND.name,
  ...OTHER_COMMANDS.map(command => command.name)
];

export const StandardCommandNameSchema = z
  .enum(STANDARD_COMMAND_NAMES)
  .describe('A standard command, by its name: `ptzload`, `swap`, `mute` and the rest.');
export type StandardCommandName = z.output<typeof StandardCommandNameSchema>;

/** The standard command a word is, by its name or one of its aliases: undefined for one that isn't. */
export function standardCommand(word: string): (typeof STANDARD_COMMANDS)[number] | undefined {
  const wanted = word.toLowerCase();
  return STANDARD_COMMANDS.find(command => command.name === wanted || command.aliases.includes(wanted));
}

/** Every word a standard command is used by: none of them may be an organisation's own command. */
export const STANDARD_WORDS: ReadonlySet<string> = new Set(
  STANDARD_COMMANDS.flatMap(command => [command.name, ...command.aliases])
);
