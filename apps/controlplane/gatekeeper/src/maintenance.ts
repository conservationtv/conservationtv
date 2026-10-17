import { lt } from 'drizzle-orm';
import { irohLeases } from './db/schema.ts';
import { useEnvironment } from './env/env.ts';

/** How long expired leases are kept for investigation. Grants, the audit record, are kept. */
const LEASE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Remove long-expired leases. */
export async function purgeExpiredState(): Promise<void> {
  const now = useEnvironment().clock();
  const db = await useEnvironment().database();
  await db.delete(irohLeases).where(lt(irohLeases.expiresAt, new Date(now - LEASE_RETENTION_MS)));
}
