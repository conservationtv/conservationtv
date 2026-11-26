import type { Principal } from '@conservationtv/umbrella';
import { and, eq, sql } from 'drizzle-orm';
import { outputs, shows, showStreams } from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { selectGatewayNetworks, selectShowReaders } from '../gateways/connect.ts';
import { unreachableStreams } from '../shows/reach.ts';
import {
  addableStreams,
  added,
  lineupEntries,
  normalised,
  removed,
  swapped,
  takeoverMix,
  type RankChange,
  type ShowFacts,
  type StreamReference
} from '../shows/resolve.ts';
import { readShowFacts, writeLineup } from '../shows/lineup.ts';
import { unchanged } from '../topology/transaction.ts';
import { organisationScope } from './organisations.ts';

// An organisation's shows (src/db/schemas/shows.ts), in the principal's request session: members read and operate
// them, administrators create, name and delete them. A show is what is on screen, composed by its object
// (src/shows/host.tsx) from what these write; how it goes out is each output's that follows it
// (src/services/outputs.ts). Each write here is followed by a poke of the show's object once it commits
// (src/shows/pokes.ts), so it looks again; nothing hands it state.

export interface NewShow {
  name: string;
}

export interface ShowChanges {
  name: string;
}

/** What operating a show changes: its layout, its own mix and its takeover. */
export interface ShowControls {
  slots?: number;
  volumeDb?: number;
  muted?: boolean;
  takeoverStreamId?: string | null;
  takeoverLive?: boolean;
}

/** How a stream is mixed in a show. */
export interface ShowStreamChanges {
  volumeDb?: number;
  muted?: boolean;
  syncOffsetMs?: number;
  audioStreamId?: string | null;
}

/** A show's own columns, as its reads return them. */
const SHOW_COLUMNS = {
  id: true,
  name: true,
  slots: true,
  volumeDb: true,
  muted: true,
  takeoverStreamId: true,
  takeoverLive: true,
  createdAt: true
} as const;

/** The outputs following a show, as its reads return them. */
const SHOW_OUTPUTS = { outputs: { columns: { id: true, name: true }, orderBy: { id: 'asc' } } } as const;

/** What a show is read with from the versions that operate it, which earlier versions leave out. */
interface OperatedShow {
  slots: number;
  volumeDb: number;
  muted: boolean;
  takeoverStreamId: string | null;
  takeoverLive: boolean;
}

/** A show as the operations before shows had controls return it (`organisations.shows.list` and `get` v1). */
export function withoutControls<Show extends OperatedShow>(show: Show) {
  const {
    slots: _slots,
    volumeDb: _volumeDb,
    muted: _muted,
    takeoverStreamId: _takeoverStreamId,
    takeoverLive: _takeoverLive,
    ...rest
  } = show;
  return rest;
}

/** The organisation's shows, oldest first, each with the outputs following it. */
export function listShows(organisationId: string) {
  const db = useDB();
  return db.query.shows.findMany({
    columns: SHOW_COLUMNS,
    with: SHOW_OUTPUTS,
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
}

/** The show, with the outputs following it, if it is visible. */
export function getShow(organisationId: string, showId: string) {
  const db = useDB();
  return db.query.shows.findFirst({ columns: SHOW_COLUMNS, with: SHOW_OUTPUTS, where: { organisationId, id: showId } });
}

/**
 * Every camera stream of the organisation for the show, if it is visible: the lineup in position order, then those
 * out of it and why, each with how the show mixes it (src/shows/resolve.ts); how it mixes the stream armed to take
 * over, which may be no camera; and, for each output following it that has an agent, which of the streams it needs
 * that agent reaches no delivery of (src/shows/reach.ts). Members read the whole topology, so all of it is read in
 * their request session.
 */
export async function getShowLineup(organisationId: string, showId: string) {
  const facts = await readShowFacts({ organisationId, showId });
  if (facts === undefined) return undefined;
  const networks = await selectGatewayNetworks(organisationId);
  const readers = await selectShowReaders(organisationId, showId);
  const unreachable = unreachableStreams(facts, networks, readers);
  return { lineup: lineupEntries(facts), addable: addableStreams(facts), takeover: takeoverMix(facts), unreachable };
}

/** Whether the show is visible: what reaching its object checks first, so a show that is not there is `not_found`. */
export async function showVisible(organisationId: string, showId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)));
  return row !== undefined;
}

/** The organisation's shows, by ID, as trusted code reads them: whose objects to poke. */
export async function selectShowIds(organisationId: string) {
  const db = useDB({ trusted: true });
  const rows = await db.select({ id: shows.id }).from(shows).where(eq(shows.organisationId, organisationId));
  return rows.map(row => row.id);
}

export async function createShow(organisationId: string, payload: NewShow) {
  const db = useDB();
  const [row] = await db
    .insert(shows)
    .values({ organisationId, name: payload.name })
    .returning({ id: shows.id, name: shows.name, createdAt: shows.createdAt });
  return row!;
}

/**
 * Rename the show, in a trusted transaction: the name is immutable to request sessions, since any member may update a
 * show to operate it (src/db/schemas/shows.ts), so whether the principal may name shows is umbrella's decision, as
 * row-level security would make it: whoever may `create` the organisation's shows. `not_found` for a principal who
 * cannot see them, or a show that is not there; `forbidden` for one who may not.
 */
export async function renameShow(principal: Principal, organisationId: string, showId: string, changes: ShowChanges) {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal, resource: shows, scope });
  if (!decision.permissions.read?.allowed) throw new ApiFailure('not_found');
  if (!decision.permissions.create?.allowed) throw new ApiFailure('forbidden');
  const db = useDB({ trusted: true });
  const [row] = await db
    .update(shows)
    .set({ name: changes.name })
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)))
    .returning({ id: shows.id, name: shows.name, createdAt: shows.createdAt });
  if (!row) throw new ApiFailure('not_found');
  return row;
}

/**
 * Operate the show: its layout, mix or takeover. Arming another stream, or disarming, ends a live takeover, unless the
 * change says whether it is live too: what goes on air is only ever what someone asked to put there. Re-arming the
 * stream already armed leaves it as it was. (The database refuses a takeover live with none armed.) `forbidden` or
 * `not_found` when the write reaches no row; `invalid_reference` for a takeover stream the organisation does not have.
 */
export async function updateShowControls(organisationId: string, showId: string, controls: ShowControls) {
  const db = useDB();
  const { takeoverStreamId, takeoverLive } = controls;
  // The right-hand side of a set reads the row as it was, so this is whether the armed stream stays the same.
  const live =
    takeoverLive ??
    (takeoverStreamId === undefined
      ? undefined
      : sql<boolean>`${shows.takeoverLive} and ${shows.takeoverStreamId} is not distinct from ${takeoverStreamId}::uuid`);
  const [row] = await db
    .update(shows)
    .set({
      slots: controls.slots,
      volumeDb: controls.volumeDb,
      muted: controls.muted,
      takeoverStreamId,
      takeoverLive: live
    })
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)))
    .returning({
      id: shows.id,
      name: shows.name,
      slots: shows.slots,
      volumeDb: shows.volumeDb,
      muted: shows.muted,
      takeoverStreamId: shows.takeoverStreamId,
      takeoverLive: shows.takeoverLive,
      createdAt: shows.createdAt
    });
  if (!row) throw await unchanged(shows.id, showId);
  return row;
}

/**
 * Change a show's lineup by a change decided against its facts, normalised in memory (`swapped`, `added`, `removed`,
 * src/shows/resolve.ts), in a trusted transaction, once umbrella says the principal may operate the organisation's
 * shows: normalising reads and writes every camera's rank, which must not depend on what the caller sees
 * (src/shows/lineup.ts), as the show's own sync and chat's swap do it. References are resolved against the lineup as it
 * is now, normalised in this transaction, which holds the show's row. `not_found` for a principal who cannot see the
 * organisation's shows, or a show that is not there; `forbidden` for one who may not operate them;
 * `invalid_reference` for a change the lineup refuses. Returns the facts after.
 */
async function changeLineup(
  principal: Principal,
  organisationId: string,
  showId: string,
  decide: (facts: ShowFacts) => RankChange[] | undefined
): Promise<ShowFacts> {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal, resource: shows, scope });
  if (!decision.permissions.read?.allowed) throw new ApiFailure('not_found');
  if (!decision.permissions.operate?.allowed) throw new ApiFailure('forbidden');
  const facts = await readShowFacts({ organisationId, showId }, true);
  if (facts === undefined) throw new ApiFailure('not_found');
  const changes = decide(normalised(facts));
  if (changes === undefined) throw new ApiFailure('invalid_reference');
  return writeLineup(facts, changes);
}

/**
 * Exchange two streams' places in a show's lineup, wherever they are: both on screen, or one off it, which is how a
 * stream is brought on (`changeLineup`). `invalid_reference` for a stream that is not in the lineup, or a position past
 * its end. Returns the lineup after.
 */
export async function swapLineup(
  principal: Principal,
  organisationId: string,
  showId: string,
  a: StreamReference,
  b: StreamReference
) {
  const after = await changeLineup(principal, organisationId, showId, facts => swapped(facts, a, b));
  return lineupEntries(after);
}

/**
 * Add a stream to the end of a show's lineup (`changeLineup`): on screen at once if a slot is free. `invalid_reference`
 * for one already in it, a camera's that is locked, or a pushed stream nobody is publishing. Returns the lineup and
 * what can be added after.
 */
export async function addToLineup(principal: Principal, organisationId: string, showId: string, streamId: string) {
  const after = await changeLineup(principal, organisationId, showId, facts => added(facts, streamId));
  return { lineup: lineupEntries(after), addable: addableStreams(after) };
}

/**
 * Take a stream out of a show's lineup (`changeLineup`): the rest move up. `invalid_reference` for one not in it.
 * Returns the lineup and what can be added after.
 */
export async function removeFromLineup(
  principal: Principal,
  organisationId: string,
  showId: string,
  stream: StreamReference
) {
  const after = await changeLineup(principal, organisationId, showId, facts => removed(facts, stream));
  return { lineup: lineupEntries(after), addable: addableStreams(after) };
}

/**
 * Set how a stream is mixed in the show, making its `show_stream` row if it has none. `invalid_reference` for a show
 * or stream (or audio stream) the organisation does not have, as the caller sees it.
 */
export async function updateShowStream(
  organisationId: string,
  showId: string,
  streamId: string,
  changes: ShowStreamChanges
) {
  const db = useDB();
  const [row] = await db
    .insert(showStreams)
    .values({ organisationId, showId, streamId, ...changes })
    .onConflictDoUpdate({ target: [showStreams.showId, showStreams.streamId], set: changes })
    .returning({
      streamId: showStreams.streamId,
      volumeDb: showStreams.volumeDb,
      muted: showStreams.muted,
      syncOffsetMs: showStreams.syncOffsetMs,
      audioStreamId: showStreams.audioStreamId
    });
  return row!;
}

/**
 * Delete the show, leaving the outputs that followed it following nothing: `forbidden` or `not_found` when the write
 * reaches no row. Its streams' settings go with it. Its object forgets it on the sync the deletion's poke asks for
 * (src/shows/host.tsx).
 */
export async function deleteShow(organisationId: string, showId: string) {
  const db = useDB();
  await db
    .update(outputs)
    .set({ showId: null })
    .where(and(eq(outputs.organisationId, organisationId), eq(outputs.showId, showId)));
  const deleted = await db
    .delete(shows)
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)))
    .returning({ id: shows.id });
  if (deleted.length === 0) throw await unchanged(shows.id, showId);
}
