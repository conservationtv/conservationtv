import { deviceSubject, exposureSubject } from '@conservationtv/reports';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { cameras, shows, showStreams } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { listSubjectStates } from '../services/subjects.ts';
import { normalisation, resolveShow, withRanks, type RankChange, type ShowFact, type ShowFacts } from './resolve.ts';

// Reading what a show is resolved from (src/shows/resolve.ts), in whichever transaction the caller is in: a member's
// request session, where row-level security decides what is visible, or trusted code, such as the show's own object
// syncing (src/shows/host.tsx). Every sync normalises the lineup and writes what that changed, in one transaction
// holding the show's row, so later syncs always see later rows and two at once cannot interleave. Commands that move
// the lineup normalise the same way first (`writeLineup`), so they resolve positions against the lineup as it is.
// Whatever writes ranks reads as trusted code: under row-level security a caller who sees less of the topology would
// take ranks from cameras it cannot see. Reads that only authorise or list normalise in memory, and come to the same
// thing for what the caller sees.

/** Which show to read: by ID, in an organisation when the caller names one. */
export interface ShowLocation {
  showId: string;
  organisationId?: string;
}

/** What else a show is resolved from, for every show of the organisation, by show. */
async function organisationFacts(organisationId: string, showIds: readonly string[]) {
  const db = useDB();
  const streams = await db.query.streams.findMany({
    columns: { id: true, name: true, code: true, sourceDeviceId: true },
    with: { exposures: { columns: { id: true, gatewayId: true }, orderBy: { id: 'asc' } } },
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
  const cameraRows = await db
    .select({ id: cameras.id, state: cameras.state })
    .from(cameras)
    .where(eq(cameras.organisationId, organisationId));
  const members = await db
    .select({
      showId: showStreams.showId,
      streamId: showStreams.streamId,
      rank: showStreams.rank,
      volumeDb: showStreams.volumeDb,
      muted: showStreams.muted,
      syncOffsetMs: showStreams.syncOffsetMs,
      audioStreamId: showStreams.audioStreamId
    })
    .from(showStreams)
    .where(and(eq(showStreams.organisationId, organisationId), inArray(showStreams.showId, [...showIds])));
  // Only what the cards are chosen from: each stream's source and deliveries.
  const subjectIds = streams.flatMap(stream => [
    ...(stream.sourceDeviceId === null ? [] : [deviceSubject(stream.sourceDeviceId)]),
    ...stream.exposures.map(exposure => exposureSubject(exposure.id))
  ]);
  const states = await listSubjectStates(organisationId, { subjectIds });
  return { streams, cameras: cameraRows, members, states };
}

/** One show's facts from its organisation's. */
function factsOf(show: ShowFact, facts: Awaited<ReturnType<typeof organisationFacts>>): ShowFacts {
  const members = facts.members.filter(member => member.showId === show.id);
  return { show, streams: facts.streams, cameras: facts.cameras, members, states: facts.states };
}

/**
 * What the show is resolved from, as the transaction sees it; undefined when it is not there for it. With `lock`, the
 * show's row is held until the transaction ends, which needs a principal that may operate it.
 */
export async function readShowFacts(location: ShowLocation, lock = false): Promise<ShowFacts | undefined> {
  const db = useDB();
  const { showId, organisationId } = location;
  const query = db
    .select({
      id: shows.id,
      organisationId: shows.organisationId,
      slots: shows.slots,
      volumeDb: shows.volumeDb,
      muted: shows.muted,
      takeoverStreamId: shows.takeoverStreamId,
      takeoverLive: shows.takeoverLive
    })
    .from(shows)
    .where(
      and(eq(shows.id, showId), organisationId === undefined ? undefined : eq(shows.organisationId, organisationId))
    );
  const [show] = lock ? await query.for('update') : await query;
  if (show === undefined) return undefined;
  return factsOf(show, await organisationFacts(show.organisationId, [show.id]));
}

/** What each of the organisation's shows is resolved from, read together, oldest show first. */
export async function readOrganisationShowFacts(organisationId: string): Promise<ShowFacts[]> {
  const db = useDB();
  const rows = await db
    .select({
      id: shows.id,
      organisationId: shows.organisationId,
      slots: shows.slots,
      volumeDb: shows.volumeDb,
      muted: shows.muted,
      takeoverStreamId: shows.takeoverStreamId,
      takeoverLive: shows.takeoverLive
    })
    .from(shows)
    .where(eq(shows.organisationId, organisationId))
    .orderBy(shows.id);
  if (rows.length === 0) return [];
  const facts = await organisationFacts(
    organisationId,
    rows.map(show => show.id)
  );
  return rows.map(show => factsOf(show, facts));
}

/** Each show of the organisation's state, by show ID, as it resolves now. */
export async function resolveOrganisationShows(organisationId: string) {
  const facts = await readOrganisationShowFacts(organisationId);
  return new Map(facts.map(each => [each.show.id, resolveShow(each)]));
}

/** Write ranks into the show's `show_stream` rows, making a row for a stream the show had none for. */
export async function writeRanks(show: ShowFact, changes: readonly RankChange[]): Promise<void> {
  if (changes.length === 0) return;
  const db = useDB();
  await db
    .insert(showStreams)
    .values(
      changes.map(({ streamId, rank }) => ({ showId: show.id, streamId, organisationId: show.organisationId, rank }))
    )
    .onConflictDoUpdate({ target: [showStreams.showId, showStreams.streamId], set: { rank: sql`excluded.rank` } });
}

/** Normalise the show's lineup (src/shows/resolve.ts), writing what that changes: the facts as it leaves them. */
export async function normaliseLineup(facts: ShowFacts): Promise<ShowFacts> {
  const changes = normalisation(facts);
  await writeRanks(facts.show, changes);
  return withRanks(facts, changes);
}

/**
 * Write a change to the lineup decided against the facts normalised in memory (`normalised`, src/shows/resolve.ts):
 * what normalising changes first, then the change. The facts as they leave them. A swap from chat or from a request
 * comes through here, as trusted code holding the show's row, so either is made against every camera's rank.
 */
export async function writeLineup(facts: ShowFacts, changes: readonly RankChange[]): Promise<ShowFacts> {
  const normal = await normaliseLineup(facts);
  await writeRanks(normal.show, changes);
  return withRanks(normal, changes);
}

/**
 * The show's state, after normalising its lineup in a transaction that holds its row: what its object composes. None
 * when the show is not there.
 */
export async function syncedShow(location: ShowLocation) {
  const facts = await readShowFacts(location, true);
  if (facts === undefined) return undefined;
  const normal = await normaliseLineup(facts);
  return { organisationId: normal.show.organisationId, state: resolveShow(normal) };
}
