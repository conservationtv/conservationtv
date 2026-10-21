import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { browsers, devices, organisationMemberships, session } from '../db/schema.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { useAuthSession, useUser } from '../middleware/principal.ts';
import { grantDevice, revokeDevice } from './device-principals.ts';
import { deviceIdentity } from './identity.ts';

// A browser device is one auth session's identity in one organisation, for iroh connections through a relay. The web
// app asks for it when it needs it, and gets it with its private key, so this is trusted code: request sessions can
// neither read private keys nor create devices unless they administer the organisation.

/** The longest device name; a browser is named after its session's user agent. */
const MAX_NAME_LENGTH = 120;

/** The device of the session's browser in the organisation, if it has one. */
function existingBrowser(sessionId: string, organisationId: string) {
  const db = useDB({ trusted: true });
  return db.query.devices.findFirst({
    columns: {
      id: true,
      kind: true,
      name: true,
      networkId: true,
      publicKey: true,
      publicId: true,
      privateKey: true,
      createdAt: true
    },
    where: { browser: { sessionId, organisationId } }
  });
}

/** Whether the user belongs to the organisation. */
async function isMember(organisationId: string) {
  const db = useDB({ trusted: true });
  const principal = useUser();
  const [membership] = await db
    .select({ id: organisationMemberships.id })
    .from(organisationMemberships)
    .where(
      and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, principal.id))
    );
  return membership !== undefined;
}

/** A name for the session's browser: its user agent, as Better Auth recorded it. */
async function browserName(sessionId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db.select({ userAgent: session.userAgent }).from(session).where(eq(session.id, sessionId));
  const userAgent = row?.userAgent?.trim() ?? '';
  return userAgent === '' ? 'Browser' : userAgent.slice(0, MAX_NAME_LENGTH);
}

/** Get or create the request session's browser device in an organisation the user belongs to, with its private key. */
export function ensureBrowser(organisationId: string) {
  return trustedTransaction(async () => {
    const db = useDB({ trusted: true });
    const principal = useUser();
    const sessionId = useAuthSession();
    // One at a time per session and organisation, so concurrent first requests make one browser between them.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${sessionId}:${organisationId}`}, 0))`
    );
    if (!(await isMember(organisationId))) throw new ApiFailure('not_found');
    const existing = await existingBrowser(sessionId, organisationId);
    if (existing) return existing;
    const identity = await deviceIdentity();
    const name = await browserName(sessionId);
    const [device] = await db
      .insert(devices)
      .values({ ...identity, organisationId, kind: 'browser', name, networkId: null })
      .returning({ id: devices.id });
    await db.insert(browsers).values({ id: device!.id, organisationId, userId: principal.id, sessionId });
    await grantDevice(organisationId, device!.id);
    const created = await existingBrowser(sessionId, organisationId);
    return created!;
  });
}

/** Delete the browsers matching `where`, their devices and their devices' grants. */
export async function deleteBrowsers(where: SQL | undefined) {
  const db = useDB({ trusted: true });
  const gone = await db
    .delete(browsers)
    .where(where)
    .returning({ id: browsers.id, organisationId: browsers.organisationId });
  if (gone.length === 0) return;
  await db.delete(devices).where(
    inArray(
      devices.id,
      gone.map(browser => browser.id)
    )
  );
  for (const browser of gone) await revokeDevice(browser.organisationId, browser.id);
}

/** Delete an auth session's browsers, before Better Auth deletes the session: on the owning connection it uses. */
export function endSessionBrowsers(sessionId: string) {
  return trustedTransaction(() => deleteBrowsers(eq(browsers.sessionId, sessionId)));
}
