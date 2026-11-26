import { createHash, randomBytes } from 'node:crypto';
import { user } from '@conservationtv/umbrella';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { authorization } from '../access.ts';
import { organisationAdmin } from '../db/roles.ts';
import { browsers, personalStreams, streamKeys, streams } from '../db/schema.ts';
import type { PersonalDevice } from '../topology/personal-devices.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { getDisplayName, getMembership, organisationScope } from './organisations.ts';
import { getStream, updateStream, type StreamChanges } from './streams.ts';

// Going live (docs/shows.md): who may publish the organisation's pushed streams, the standing stream each member goes
// live on from the studio, and the keys encoders publish with. Keys are read and written in the caller's request
// session, so row-level security decides whose (`streamPublisher`, src/db/schemas/publishing.ts); nothing else reads
// one. The stream a member goes live on is made by trusted code, once `requirePublisher` has decided what row-level
// security would. A member's personal stream is theirs alone to publish and to hold the key of (`requireOwnStream`):
// row-level security lets any publisher at every key, so that is decided here, before it.

/** How many random bytes a stream key is: as unguessable as a token, so its digest needs no salt. */
const KEY_BYTES = 32;

/**
 * Refuses the user unless they may publish the organisation's pushed streams: `not_found` if they are not a member,
 * `forbidden` if they may not hold its stream keys, which is the right to publish (an encoder with the key could
 * anyway). The decision row-level security makes on `stream_key`, from its own roles. Trusted code.
 */
export async function requirePublisher(organisationId: string, userId: string) {
  const membership = await getMembership(organisationId, userId);
  if (membership === undefined) throw new ApiFailure('not_found');
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal: user(userId), resource: streamKeys, scope });
  if (!decision.permissions.create?.allowed) throw new ApiFailure('forbidden');
}

/** Whether the user may hold the organisation's stream keys, the right to publish: trusted code. */
async function mayPublish(organisationId: string, userId: string) {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal: user(userId), resource: streamKeys, scope });
  return decision.permissions.create?.allowed === true;
}

/**
 * Remove the keys of the member's personal streams once they may no longer publish, so an encoder they set up is
 * refused from its agent's next configuration on: called in the transaction that took their roles away, before their
 * membership goes (which takes `personal_stream` with it). Their streams stay the organisation's. A shared stream's key
 * stays: every publisher may read it, so it is replaced by an administrator (docs/shows.md, Stream keys). Trusted code,
 * since the administrator's own access need not reach the row.
 */
export async function dropPersonalStreamKeys(organisationId: string, userId: string) {
  if (await mayPublish(organisationId, userId)) return;
  const db = useDB({ trusted: true });
  const owned = db
    .select({ streamId: personalStreams.streamId })
    .from(personalStreams)
    .where(and(eq(personalStreams.organisationId, organisationId), eq(personalStreams.userId, userId)));
  await db
    .delete(streamKeys)
    .where(and(eq(streamKeys.organisationId, organisationId), inArray(streamKeys.streamId, owned)));
}

/** The member the stream is personal to (`personal_stream`), as the transaction sees it: none for a shared stream. */
async function selectPersonalOwner(organisationId: string, streamId: string) {
  const db = useDB();
  const [row] = await db
    .select({ userId: personalStreams.userId })
    .from(personalStreams)
    .where(and(eq(personalStreams.organisationId, organisationId), eq(personalStreams.streamId, streamId)));
  return row?.userId;
}

/** Whether the user holds an active administrator grant at the organisation, as the transaction reads grants. */
async function isAdmin(organisationId: string, userId: string) {
  const db = useDB();
  const access = authorization.access(db);
  const scope = organisationScope(organisationId);
  const held = await access.grantsQuery({ principal: user(userId), role: organisationAdmin, scope, active: true });
  return held.length > 0;
}

/** Who besides a personal stream's owner may act on it: nobody, or the organisation's administrators too. */
export type OwnStreamRule = 'owner' | 'ownerOrAdmin';

/**
 * Refuses the user a personal stream that is someone else's: `forbidden`, unless `rule` lets an administrator. A shared
 * stream is any publisher's, as row-level security decides. Members read `personal_stream`, so this runs in either
 * kind of transaction.
 */
export async function requireOwnStream(
  organisationId: string,
  streamId: string,
  userId: string,
  rule: OwnStreamRule = 'owner'
) {
  const owner = await selectPersonalOwner(organisationId, streamId);
  if (owner === undefined || owner === userId) return;
  if (rule === 'ownerOrAdmin' && (await isAdmin(organisationId, userId))) return;
  throw new ApiFailure('forbidden');
}

/** The member whose session's browser the device is: none for a device that is no browser. Trusted code. */
export async function selectBrowserUser(organisationId: string, deviceId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ userId: browsers.userId })
    .from(browsers)
    .where(and(eq(browsers.organisationId, organisationId), eq(browsers.id, deviceId)));
  return row?.userId;
}

/** What a pushed stream is called when it is made for someone: "Ada's phone". */
function personalName(displayName: string | undefined, device: PersonalDevice) {
  const whose = displayName === undefined || displayName.trim() === '' ? 'My' : `${displayName.trim()}’s`;
  return `${whose} ${device}`.slice(0, 120);
}

/**
 * The stream the user goes live on from this kind of device: the one they went live on before, or a new pushed stream
 * named for them, made now. Trusted code, once `requirePublisher` let them; one at a time per user and device.
 */
export async function ensurePersonalStream(organisationId: string, userId: string, device: PersonalDevice) {
  const db = useDB({ trusted: true });
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`personal-stream:${organisationId}:${userId}:${device}`}, 0))`
  );
  const columns = {
    id: streams.id,
    name: streams.name,
    code: streams.code,
    sourceDeviceId: streams.sourceDeviceId,
    createdAt: streams.createdAt
  };
  const [existing] = await db
    .select(columns)
    .from(personalStreams)
    .innerJoin(streams, eq(streams.id, personalStreams.streamId))
    .where(
      and(
        eq(personalStreams.organisationId, organisationId),
        eq(personalStreams.userId, userId),
        eq(personalStreams.device, device)
      )
    );
  if (existing !== undefined) return existing;
  const displayName = await getDisplayName(organisationId, userId);
  const [created] = await db
    .insert(streams)
    .values({ organisationId, name: personalName(displayName, device), sourceDeviceId: null })
    .returning(columns);
  await db.insert(personalStreams).values({ organisationId, userId, device, streamId: created!.id });
  return created!;
}

/** A new key, and the digest the agents admitting it are told. */
function newKey() {
  const key = randomBytes(KEY_BYTES).toString('base64url');
  return { key, keySha256: streamKeyDigest(key) };
}

/** The digest of a stream key, as agents compare an offered key against: SHA-256, in lowercase hex. */
export function streamKeyDigest(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

/** The stream's key, if there is one and the caller may read it. */
export async function getStreamKey(organisationId: string, streamId: string) {
  const db = useDB();
  const [row] = await db
    .select({ key: streamKeys.key, createdAt: streamKeys.createdAt })
    .from(streamKeys)
    .where(and(eq(streamKeys.organisationId, organisationId), eq(streamKeys.streamId, streamId)));
  return row;
}

/** The stream's key: the one it has, or a new one made now. Row-level security refuses a caller who may not. */
export async function ensureStreamKey(organisationId: string, streamId: string) {
  const existing = await getStreamKey(organisationId, streamId);
  if (existing !== undefined) return existing;
  const db = useDB();
  const [created] = await db
    .insert(streamKeys)
    .values({ organisationId, streamId, ...newKey() })
    .onConflictDoNothing()
    .returning({ key: streamKeys.key, createdAt: streamKeys.createdAt });
  // A concurrent first ask made it: that one stands.
  return created ?? (await getStreamKey(organisationId, streamId))!;
}

/**
 * A new key for the user to publish the stream with, in place of any it had, so an encoder with the old one is refused
 * from its agent's next configuration on: `not_found` for a stream they cannot see, `not_pushed` for one with a source
 * of its own (whose key would admit nothing, and would again if it lost its source), `forbidden` for someone else's
 * personal stream. Row-level security refuses a caller who may not publish.
 */
export async function replaceStreamKey(organisationId: string, streamId: string, userId: string) {
  const stream = await getStream(organisationId, streamId);
  if (stream === undefined) throw new ApiFailure('not_found');
  if (stream.sourceDeviceId !== null) throw new ApiFailure('not_pushed');
  await requireOwnStream(organisationId, streamId, userId);
  const db = useDB();
  const { key, keySha256 } = newKey();
  const [row] = await db
    .insert(streamKeys)
    .values({ organisationId, streamId, key, keySha256 })
    .onConflictDoUpdate({ target: streamKeys.streamId, set: { key, keySha256, createdAt: sql`now()` } })
    .returning({ key: streamKeys.key, createdAt: streamKeys.createdAt });
  return row!;
}

/**
 * Remove the stream's key, so no encoder publishes it: `forbidden` for someone else's personal stream unless the user
 * is an administrator, and `not_found` if it has none the caller may remove.
 */
export async function deleteStreamKey(organisationId: string, streamId: string, userId: string) {
  await requireOwnStream(organisationId, streamId, userId, 'ownerOrAdmin');
  const removed = await removeStreamKey(organisationId, streamId);
  if (!removed) throw new ApiFailure('not_found');
}

/**
 * Change the stream as `updateStream` does, and remove its key once it has a source device of its own: the key admits
 * nothing while it has one, and must not admit an encoder again if the source is taken away. In the caller's request
 * session, an administrator's, whose access reaches the key.
 */
export async function updateStreamAndKey(organisationId: string, streamId: string, changes: StreamChanges) {
  const row = await updateStream(organisationId, streamId, changes);
  if (row.sourceDeviceId !== null) await removeStreamKey(organisationId, streamId);
  return row;
}

/** Remove the stream's key if it has one the caller may remove: whether it had. */
async function removeStreamKey(organisationId: string, streamId: string) {
  const db = useDB();
  const removed = await db
    .delete(streamKeys)
    .where(and(eq(streamKeys.organisationId, organisationId), eq(streamKeys.streamId, streamId)))
    .returning({ streamId: streamKeys.streamId });
  return removed.length > 0;
}

/**
 * The digest of each of these streams' keys, by stream ID, for the agent admitting their encoders: trusted code, and
 * the digest alone, never the key.
 */
export async function selectStreamKeyDigests(streamIds: readonly string[]) {
  if (streamIds.length === 0) return new Map<string, string>();
  const db = useDB({ trusted: true });
  const rows = await db
    .select({ streamId: streamKeys.streamId, keySha256: streamKeys.keySha256 })
    .from(streamKeys)
    .where(inArray(streamKeys.streamId, [...streamIds]));
  return new Map(rows.map(row => [row.streamId, row.keySha256]));
}
