// What a show comes to, by the API's own pure code (apps/studio/api/src/shows/resolve.ts, and packages/shows for what a
// state places), imported rather than copied, as the status rule is: the lineup, its positions, what is not placed and
// why, the cards, and what an output may read all come from the same functions the show's object and its reads use.
// Only the facts are made here, from the world, as src/shows/lineup.ts reads them from the database. Which streams an
// output following a show cannot reach is the API's too (src/shows/reach.ts), from where each output's agent reads, as
// src/gateways/connect.ts reads it.
import { placedStreams } from '../../../../../packages/shows/src/state.ts';
import { unreachableStreams, type OutputReach, type OutputReader } from '../../../api/src/shows/reach.ts';
import { resolveShow, type MemberFact, type ShowFacts } from '../../../api/src/shows/resolve.ts';
import type { CameraRow, DeviceRow, OutputRow, ShowRow, StateRow, StreamRow } from './model.ts';

/** What a show is resolved from in a world: the organisation's lists, and the show's own `show_stream` rows. */
export interface ShowSources {
  organisationId: string;
  streams: readonly StreamRow[];
  cameras: readonly CameraRow[];
  /** Each show's `show_stream` rows, by show ID. */
  showStreams: Record<string, MemberFact[]>;
  states: readonly StateRow[];
}

/** Anything with an ID. */
interface Identified {
  id: string;
}

const oldestFirst = (a: Identified, b: Identified) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The facts a show is resolved from, as the API reads them (`readShowFacts`): the organisation's streams oldest first,
 * each with its deliveries oldest first, its cameras, the show's members, and the states of what feeds the streams.
 */
export function showFactsOf(sources: ShowSources, show: ShowRow): ShowFacts {
  const { id, slots, volumeDb, muted, takeoverStreamId, takeoverLive } = show;
  return {
    show: { id, organisationId: sources.organisationId, slots, volumeDb, muted, takeoverStreamId, takeoverLive },
    streams: [...sources.streams].sort(oldestFirst).map(({ id, name, code, sourceDeviceId, exposures }) => ({
      id,
      name,
      code,
      sourceDeviceId,
      exposures: [...exposures].sort(oldestFirst).map(exposure => ({ id: exposure.id, gatewayId: exposure.gatewayId }))
    })),
    cameras: sources.cameras.map(({ id, state }) => ({ id, state })),
    members: sources.showStreams[show.id] ?? [],
    states: sources.states.map(state => ({ ...state, observedAt: new Date(state.observedAt) }))
  };
}

/** The streams a show places, by ID, as its state says (`placedStreams`): what its outputs read, and its status is of. */
export function placedStreamsOf(sources: ShowSources, show: ShowRow): string[] {
  return placedStreams(resolveShow(showFactsOf(sources, show)));
}

/** Where the outputs of a world are run, for the readers of a show. */
export interface ReaderSources {
  outputs: readonly OutputRow[];
  devices: readonly DeviceRow[];
}

/**
 * The outputs following the show that have an agent, oldest first, each as its agent reads (`selectShowReaders`): its
 * device's network, and the one gateway it reads from. An output with no agent reads nothing.
 */
export function showReadersOf(sources: ReaderSources, show: ShowRow): OutputReader[] {
  const following = [...sources.outputs].filter(output => output.showId === show.id).sort(oldestFirst);
  return following.flatMap(output => {
    const device = sources.devices.find(candidate => candidate.id === output.device?.deviceId);
    if (device === undefined) return [];
    return [{ outputId: output.id, networkId: device.networkId, inputGatewayId: output.inputGatewayId }];
  });
}

/**
 * Which of the streams the show needs each of those outputs cannot reach (`unreachableStreams`), given each gateway's
 * network, built in or the organisation's.
 */
export function unreachableOf(
  sources: ShowSources,
  outputs: ReaderSources,
  show: ShowRow,
  networks: ReadonlyMap<string, string | null>
): OutputReach[] {
  const facts = showFactsOf(sources, show);
  const readers = showReadersOf(outputs, show);
  return unreachableStreams(facts, networks, readers);
}
