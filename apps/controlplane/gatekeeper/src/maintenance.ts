import { lt } from 'drizzle-orm';
import { assertionReplays, irohLeases } from './db/schema.ts';
import { useServices } from './services.ts';

/** How long expired leases are kept for investigation. Grants, the audit record, are kept. */
const LEASE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Remove replay identifiers that could no longer be accepted anyway, and long-expired leases. */
export async function purgeExpiredState(): Promise<void> {
  const now = useServices().clock();
  const db = await useServices().database();
  await db.delete(assertionReplays).where(lt(assertionReplays.expiresAt, new Date(now)));
  await db.delete(irohLeases).where(lt(irohLeases.expiresAt, new Date(now - LEASE_RETENTION_MS)));
}
