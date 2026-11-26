import { STANDARD_COMMANDS, type StandardCommand, type StandardCommandName } from '@conservationtv/chat';
import type { ShowFacts } from '../shows/resolve.ts';
import { planCameraCommand } from './cameras.ts';
import { notRun, type NotRun, type StandardPlan, type UseFacts } from './decide.ts';
import type { NamedCamera, Unresolved } from './resolve.ts';
import {
  planGetVolume,
  planLiveCams,
  planMute,
  planResetVolume,
  planSceneCams,
  planSetVolume,
  planShowSwap,
  planShowTakeover,
  planSlots,
  type ShowPlan,
  type ShowSay
} from './shows.ts';

// What a standard command (`@conservationtv/chat`) comes to with the facts of a use, its rest aside: the camera or show
// its turn is taken on, and what it does (src/chat/decide.ts). A camera command plans in src/chat/cameras.ts, and
// needs an agent that reaches its camera; a layout or audio command plans in src/chat/shows.ts, and needs the show
// the output follows.

/** The standard command by this name, as the catalogue has it. */
export function standardByName(name: StandardCommandName): StandardCommand {
  return STANDARD_COMMANDS.find(command => command.name === name)!;
}

type ShowPlanner = (
  show: ShowFacts,
  words: readonly string[],
  cameras: readonly NamedCamera[]
) => ShowPlan | ShowSay | Unresolved;

/** Each layout and audio command's planner, by name. */
const SHOW_PLANNERS = {
  swap: planShowSwap,
  slots: (show, words) => planSlots(show, words),
  scenecams: show => planSceneCams(show),
  takeover: planShowTakeover,
  livecams: (show, _words, cameras) => planLiveCams(show, cameras),
  mute: (show, words, cameras) => planMute(show, words, cameras, true),
  unmute: (show, words, cameras) => planMute(show, words, cameras, false),
  setvolume: planSetVolume,
  getvolume: planGetVolume,
  resetvolume: show => planResetVolume(show)
} as const satisfies Partial<Record<StandardCommandName, ShowPlanner>>;

/** Whether a standard command is one of the layout and audio commands planned here. */
function isShowCommand(name: StandardCommandName): name is keyof typeof SHOW_PLANNERS {
  return Object.hasOwn(SHOW_PLANNERS, name);
}

/** What a standard command comes to with these facts: its target and effect, or why it doesn't run. */
export function planStandard(name: StandardCommandName, facts: UseFacts): StandardPlan | NotRun {
  const command = standardByName(name);
  if (command.group === 'camera') return planCamera(name, facts);
  const { show, words, cameras } = facts;
  if (show === undefined) return notRun('unavailable', null, 'There is no show here to change.');
  if (!isShowCommand(name)) return notRun('unresolved', null, null);
  const planner: ShowPlanner = SHOW_PLANNERS[name];
  const planned = planner(show, words, cameras);
  if (!planned.ok) return notRun('unresolved', null, planned.reply);
  const targetId = show.show.id;
  if (planned.change === null) return { kind: 'plan', targetId, effect: { kind: 'say', text: planned.reply } };
  return { kind: 'plan', targetId, effect: { kind: 'show', show, change: planned.change, text: planned.reply } };
}

/** What a camera command comes to: unavailable while no agent reaches its camera, unless it only says something. */
function planCamera(name: StandardCommandName, facts: UseFacts): StandardPlan | NotRun {
  const planned = planCameraCommand(name, facts.words, facts.cameras, facts.show);
  if (!planned.ok) return notRun('unresolved', null, planned.reply);
  const { camera, effect } = planned;
  if (effect.kind === 'say') return { kind: 'plan', targetId: camera.id, effect };
  const agent = facts.servingAgents.get(camera.id);
  if (agent === undefined) return notRun('unavailable', null, `${camera.name} can't be moved right now.`);
  return {
    kind: 'plan',
    targetId: camera.id,
    effect: {
      kind: 'move',
      camera: { id: camera.id, name: camera.name },
      agent,
      commands: effect.commands,
      text: effect.text
    }
  };
}
