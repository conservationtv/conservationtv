import { liveOf, statusOf } from '../api/projections.ts';
import { focusOrganisation, type World } from '../world/model.ts';

// The pages to capture in a world: every page of the app that it has something for. A detail page shows the entity the
// world has most to say about (one with a problem, if any), so failures reach the screenshots.

export interface Page {
  /** Stable across runs, for comparing with a baseline: `streams/detail`. */
  id: string;
  title: string;
  path: string;
}

/** How much trouble each status is, worst first. */
const TROUBLE = new Map(
  Object.entries({ failing: 0, degraded: 1, affected: 2, unknown: 3, off: 4, idle: 5, healthy: 6 })
);

/** The first of `ids` whose status is worst, so a detail page shows trouble when there is any. */
function mostTroubled(ids: string[], statuses: Map<string, string>): string | undefined {
  const rank = (id: string) => TROUBLE.get(statuses.get(id) ?? 'healthy') ?? 6;
  return [...ids].sort((a, b) => rank(a) - rank(b))[0];
}

/** The lists a detail page can show one of: `pushed` is the streams people publish to, one live now first. */
type Detailed = 'streams' | 'pushed' | 'shows' | 'outputs' | 'agents' | 'cameras';

/** A page of an organisation; a detail page shows one of a list, beneath the list's path. */
interface OrganisationPage {
  id: string;
  title: string;
  path: string;
  detail?: Detailed;
}

/** An organisation's pages, in the order they are captured. */
const ORGANISATION_PAGES: OrganisationPage[] = [
  { id: 'home', title: 'Overview', path: '' },
  { id: 'controls', title: 'Controls', path: '/controls' },
  { id: 'live', title: 'Go live', path: '/live' },
  { id: 'streams', title: 'Streams', path: '/streams' },
  { id: 'streams/detail', title: 'Stream', path: '/streams', detail: 'streams' },
  { id: 'streams/pushed', title: 'Pushed stream', path: '/streams', detail: 'pushed' },
  { id: 'shows', title: 'Shows', path: '/shows' },
  { id: 'shows/detail', title: 'Show', path: '/shows', detail: 'shows' },
  { id: 'outputs', title: 'Outputs', path: '/outputs' },
  { id: 'outputs/detail', title: 'Output', path: '/outputs', detail: 'outputs' },
  { id: 'channels', title: 'Channels', path: '/channels' },
  { id: 'chat-commands', title: 'Chat commands', path: '/chat-commands' },
  { id: 'networks', title: 'Networks', path: '/networks' },
  { id: 'agents', title: 'Agents', path: '/agents' },
  { id: 'agents/detail', title: 'Agent', path: '/agents', detail: 'agents' },
  { id: 'cameras', title: 'Cameras', path: '/cameras' },
  { id: 'cameras/detail', title: 'Camera', path: '/cameras', detail: 'cameras' },
  { id: 'gateways', title: 'Gateways', path: '/gateways' },
  { id: 'publishers', title: 'Publishers', path: '/publishers' },
  { id: 'devices', title: 'Devices', path: '/devices' },
  { id: 'settings', title: 'Settings', path: '/settings' },
  { id: 'settings/members', title: 'Members', path: '/settings/members' },
  { id: 'settings/roles', title: 'Roles', path: '/settings/roles' }
];

/** Each list's IDs, and the statuses that say which is in most trouble: groups' for what the status sums up, subjects' for devices. */
interface DetailSource {
  ids: string[];
  statuses: Map<string, string>;
}

function detailSources(world: World) {
  const status = statusOf(world);
  const groups = new Map(
    [...status.streams, ...status.outputs, ...status.shows].map((group): [string, string] => [group.id, group.status])
  );
  const subjects = new Map(
    status.subjects.map(subject => [subject.subjectId.replace(/^device:/u, ''), subject.status])
  );
  const idsOf = (rows: readonly Identified[]) => rows.map(row => row.id);
  // A pushed stream is never in trouble for nobody publishing it, so the one shown is one live now, shared first.
  const pushed = [...world.sharedStreams, ...world.personalStreams.map(personal => personal.streamId)];
  const live = new Set(liveOf(world).exposures.flatMap(exposure => (exposure.live ? [exposure.streamId] : [])));
  return {
    streams: { ids: idsOf(world.streams), statuses: groups },
    pushed: { ids: [...pushed.filter(id => live.has(id)), ...pushed.filter(id => !live.has(id))], statuses: new Map() },
    shows: { ids: idsOf(world.shows), statuses: groups },
    outputs: { ids: idsOf(world.outputs), statuses: groups },
    agents: { ids: idsOf(world.agents), statuses: subjects },
    cameras: { ids: idsOf(world.cameras), statuses: subjects }
  } satisfies Record<Detailed, DetailSource>;
}

/** Anything with an ID. */
interface Identified {
  id: string;
}

/** The account's pages, then its organisation's, each detail page only when its list has something to show. */
export function pagesOf(world: World): Page[] {
  const pages: Page[] = [
    { id: 'organisations', title: 'Organisations', path: '/organisations' },
    { id: 'account', title: 'Account', path: '/account' }
  ];
  for (const invitation of world.myInvitations.slice(0, 1)) {
    pages.push({ id: 'invitation', title: 'Invitation', path: `/invitations/${invitation.id}` });
  }
  const organisation = focusOrganisation(world);
  if (!organisation) {
    pages.push({ id: 'organisations/new', title: 'New organisation', path: '/organisations/new' });
    return pages;
  }
  const base = `/organisations/${organisation.id}`;
  const sources = detailSources(world);
  for (const page of ORGANISATION_PAGES) {
    // A detail page shows the list's most troubled entry, and is left out when the list is empty.
    const source = page.detail ? sources[page.detail] : undefined;
    const id = source ? mostTroubled(source.ids, source.statuses) : undefined;
    if (source && !id) continue;
    pages.push({ id: page.id, title: page.title, path: `${base}${page.path}${id ? `/${id}` : ''}` });
  }
  return pages;
}
