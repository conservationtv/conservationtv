import { and, eq, sql, type SQL } from 'drizzle-orm';
import { browsers, session } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { deleteDevice } from './devices.ts';

// A browser device is one auth session's identity in one organisation, for iroh connections through a relay, created
// beside its device (src/services/devices.ts). The web app gets it with its private key, so this is trusted code:
// request sessions can neither read private keys nor create devices unless they administer the organisation.

/** The longest device name; a browser is named after its session's user agent. */
const MAX_NAME_LENGTH = 120;

export interface NewBrowser {
  userId: string;
  sessionId: string;
}

/**
 * Lock the session's browser in the organisation for the rest of the transaction, so concurrent first requests make
 * one browser between them.
 */
export async function lockSessionBrowser(organisationId: string, sessionId: string) {
  const db = useDB({ trusted: true });
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${sessionId}:${organisationId}`}, 0))`);
}

/** The device of the session's browser in the organisation, with its private key, if it has one. */
export function getSessionBrowser(organisationId: string, sessionId: string) {
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

/** A name for the session's browser: its user agent, as Better Auth recorded it. */
export async function sessionBrowserName(sessionId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db.select({ userAgent: session.userAgent }).from(session).where(eq(session.id, sessionId));
  const userAgent = row?.userAgent?.trim() ?? '';
  return userAgent === '' ? 'Browser' : userAgent.slice(0, MAX_NAME_LENGTH);
}

/** Make the device the session's browser in the organisation. */
export async function createBrowser(organisationId: string, browserId: string, payload: NewBrowser) {
  const db = useDB({ trusted: true });
  await db
    .insert(browsers)
    .values({ id: browserId, organisationId, userId: payload.userId, sessionId: payload.sessionId });
}

/** Delete the browsers matching `where`, with their devices and their devices' grants. */
async function deleteBrowsersWhere(where: SQL | undefined) {
  const db = useDB({ trusted: true });
  const gone = await db
    .delete(browsers)
    .where(where)
    .returning({ id: browsers.id, organisationId: browsers.organisationId });
  for (const browser of gone) await deleteDevice(browser.organisationId, browser.id);
}

/** Delete the user's browsers in the organisation, as their membership ends. */
export function deleteMemberBrowsers(organisationId: string, userId: string) {
  return deleteBrowsersWhere(and(eq(browsers.organisationId, organisationId), eq(browsers.userId, userId)));
}

/** Delete an auth session's browsers, as the session ends. */
export function deleteSessionBrowsers(sessionId: string) {
  return deleteBrowsersWhere(eq(browsers.sessionId, sessionId));
}
