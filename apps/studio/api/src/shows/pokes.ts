import { trustedTransaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { selectShowIds } from '../services/shows.ts';

// Telling shows to look again (docs/shows.md): a poke is `sync()` on a show's object (src/shows/host.tsx), which reads
// the database itself, so a poke carries nothing and a missed or repeated one is harmless. Each runs in the
// environment's background, after whatever caused it has committed, so a poke can never fail or slow the request
// that made it: a failure is logged, and the object's own alarm is the backstop.
//
// What pokes a show: any audited configuration change, after it succeeds and its entry is written (src/audit/audit.ts):
// a show command pokes its own show, and any other change each show in its organisation, which is how locking a
// camera, adding an exposure or renaming a stream arrive; a chat show command, after it commits
// (src/routes/chat-commands.ts); and a recorded health transition (src/health/consumer.ts).
//
// Finding the organisation's shows is a transaction on the request's connection, started in the background, so it
// must start only once the request's own transactions are over: one begun on a connection already in a transaction is
// a savepoint of it, and the two would commit or roll back together.

/** Sync one show's object, in the background. */
export function pokeShow(showId: string): void {
  const environment = useEnvironment();
  environment.background(syncShow(showId));
}

/** Sync each of the organisation's shows' objects, in the background: which they are is read there too. */
export function pokeOrganisationShows(organisationId: string): void {
  const environment = useEnvironment();
  environment.background(syncOrganisationShows(organisationId));
}

/** Sync one show's object; a failure is logged. */
async function syncShow(showId: string): Promise<void> {
  const environment = useEnvironment();
  const broadcast = environment.broadcasts.get(showId);
  try {
    await broadcast.sync();
  } catch (error) {
    console.warn(JSON.stringify({ event: 'show_poke_failed', showId, cause: String(error) }));
  }
}

/** Sync every one of the organisation's shows, each whatever the others come to; a failure to find them is logged. */
async function syncOrganisationShows(organisationId: string): Promise<void> {
  try {
    const showIds = await trustedTransaction(() => selectShowIds(organisationId), { name: 'shows.poke' });
    await Promise.all(showIds.map(syncShow));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'shows_poke_failed', organisationId, cause: String(error) }));
  }
}
