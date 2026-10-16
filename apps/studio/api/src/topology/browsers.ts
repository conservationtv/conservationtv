import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Access } from '@conservationtv/umbrella';
import { authorization } from '../access.ts';
import type { Database } from '../db/client.ts';
import { browsers, devices, organisationMemberships, session } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { UserPrincipal } from '../middleware/principal.ts';
import { trusted, type Transaction } from '../organisations/membership.ts';
import { grantDevice, revokeDevice } from './device-principals.ts';
import { deviceIdentity } from './identity.ts';

// A browser device is one auth session's identity in one organisation, for iroh connections through a relay. The web
// app asks for it when it needs it, and gets it with its private key, so this is trusted code: request sessions can
// neither read private keys nor create devices unless they administer the organisation.

/** The longest device name; a browser is named after its session's user agent. */
const MAX_NAME_LENGTH = 120;

/** A browser as the route returns it: its device, with the private key. */
const browserQuery = {
  columns: {
    id: true,
    kind: true,
    name: true,
    networkId: true,
    publicKey: true,
    publicId: true,
    privateKey: true,
    createdAt: true
  }
} as const;

/** The device of the session's browser in the organisation, if it has one. */
function existingBrowser(tx: Transaction, sessionId: string, organisationId: string) {
  return tx.query.devices.findFirst({ ...browserQuery, where: { browser: { sessionId, organisationId } } });
}

/** Whether the principal belongs to the organisation. */
async function isMember(tx: Transaction, principal: UserPrincipal, organisationId: string) {
  const [membership] = await tx
    .select({ id: organisationMemberships.id })
    .from(organisationMemberships)
    .where(
      and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, principal.id))
    );
  return membership !== undefined;
}

/** A name for the session's browser: its user agent, as Better Auth recorded it. */
async function browserName(tx: Transaction, sessionId: string) {
  const [row] = await tx.select({ userAgent: session.userAgent }).from(session).where(eq(session.id, sessionId));
  const userAgent = row?.userAgent?.trim() ?? '';
  return userAgent === '' ? 'Browser' : userAgent.slice(0, MAX_NAME_LENGTH);
}

/** Get or create the session's browser device in an organisation the principal belongs to, with its private key. */
export function ensureBrowser(principal: UserPrincipal, sessionId: string, organisationId: string) {
  return trusted(async (tx, access) => {
    // One at a time per session and organisation, so concurrent first requests make one browser between them.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${sessionId}:${organisationId}`}, 0))`
    );
    if (!(await isMember(tx, principal, organisationId))) throw new ApiFailure('not_found');
    const existing = await existingBrowser(tx, sessionId, organisationId);
    if (existing) return existing;
    const identity = await deviceIdentity();
    const name = await browserName(tx, sessionId);
    const [device] = await tx
      .insert(devices)
      .values({ ...identity, organisationId, kind: 'browser', name, networkId: null })
      .returning({ id: devices.id });
    await tx.insert(browsers).values({ id: device!.id, organisationId, userId: principal.id, sessionId });
    await grantDevice(access, organisationId, device!.id);
    const created = await existingBrowser(tx, sessionId, organisationId);
    return created!;
  });
}

/** Delete the browsers matching `where`, their devices and their devices' grants. */
export async function deleteBrowsers(tx: Transaction, access: Access, where: SQL | undefined) {
  const gone = await tx
    .delete(browsers)
    .where(where)
    .returning({ id: browsers.id, organisationId: browsers.organisationId });
  if (gone.length === 0) return;
  await tx.delete(devices).where(
    inArray(
      devices.id,
      gone.map(browser => browser.id)
    )
  );
  for (const browser of gone) await revokeDevice(access, browser.organisationId, browser.id);
}

/** Delete an auth session's browsers, before Better Auth deletes the session: on the owning connection it uses. */
export function endSessionBrowsers(database: Database, sessionId: string) {
  return database.transaction(tx => deleteBrowsers(tx, authorization.access(tx), eq(browsers.sessionId, sessionId)));
}
