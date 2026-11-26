import { z } from 'zod';

// The streams that went live which a viewer dismissed from a show's prompt (src/components/shows/show-live-sources.tsx),
// by show, for this tab's visit: kept in sessionStorage so leaving the show and coming back does not offer them again.
// Storage may be unavailable (a private window, blocked site data): then a dismissal lasts while the show is open.
//
// This module is the record's format. Reading and writing go through the this-device queries
// (src/queries/this-device.ts), so the app always sees the record through TanStack Query.

const STORAGE_KEY_PREFIX = 'studio.live-source-dismissals.';

const DismissalsSchema = z.array(z.string());
type Dismissals = z.output<typeof DismissalsSchema>;

/** Read the show's dismissals; none kept, or an unreadable value, is none. */
export function readLiveSourceDismissals(showId: string): Dismissals {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_PREFIX + showId);
    return raw === null ? [] : DismissalsSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeLiveSourceDismissals(showId: string, streamIds: Dismissals): void {
  try {
    if (streamIds.length) sessionStorage.setItem(STORAGE_KEY_PREFIX + showId, JSON.stringify(streamIds));
    else sessionStorage.removeItem(STORAGE_KEY_PREFIX + showId);
  } catch {
    // Without storage the query's cache still holds them for as long as the page is open.
  }
}
