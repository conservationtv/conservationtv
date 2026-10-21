import { createStore } from '@conservationtv/store';
import { authorization } from '../access.ts';
import { useEnvironment } from '../env/env.ts';
import { usePrincipal } from '../middleware/principal.ts';
import type { Database } from './client.ts';

// Every query runs in a transaction, and code reads the one it is in through `useDB()` rather than threading it
// through every call. A request transaction (`transaction`) runs as the request's principal over the application
// connection, so row-level security decides what it reads and writes. A trusted transaction (`trustedTransaction`)
// runs on the owning connection, for writes row-level security cannot authorise, such as grants; `useDB()` sees it
// too, and `useDB({ trusted: true })` sees only it. Neither nests: the two run on different connections, so one inside
// the other would be neither atomic with it nor safe from waiting on its locks.

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const [withTransaction, useTransaction] = createStore<Transaction>('transaction');
const [withTrustedTransaction, useTrustedTransaction] = createStore<Transaction>('trustedTransaction');

export interface UseDBOptions {
  /** Only a trusted transaction: throws in a request transaction. */
  trusted?: boolean;
}

/** The transaction the caller is in: `{ trusted: true }` only a trusted one. Throws outside one. */
export function useDB(options?: UseDBOptions) {
  if (options?.trusted) return useTrustedTransaction();
  return useTransaction();
}

/** The management API over the trusted transaction the caller is in, which may write grants. */
export function useAccess() {
  const db = useDB({ trusted: true });
  return authorization.access(db);
}

function refuseNesting() {
  try {
    useTransaction();
  } catch {
    return;
  }
  throw new Error('Transactions do not nest: run this outside the transaction it was started in');
}

/** Run `run` in a transaction as the request's principal, over the application connection. */
export async function transaction<Result>(run: () => Promise<Result>) {
  refuseNesting();
  const environment = useEnvironment();
  const principal = usePrincipal();
  const session = await environment.session(principal);
  return session.transaction(tx => withTransaction(tx, run));
}

/** Run `run` in a trusted transaction on the owning connection. */
export async function trustedTransaction<Result>(run: () => Promise<Result>) {
  refuseNesting();
  const environment = useEnvironment();
  const admin = await environment.admin();
  return admin.transaction(tx => withTrustedTransaction(tx, () => withTransaction(tx, run)));
}
