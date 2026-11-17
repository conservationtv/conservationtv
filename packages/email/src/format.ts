/**
 * Dates as the emails write them. The recipient's time zone is unknown when an email is rendered, so times are given in
 * UTC and say so.
 */
const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
const moment = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });

/** "16 November 2026" */
export function formatDay(date: Date): string {
  return day.format(date);
}

/** "16 November 2026 at 12:42 UTC" */
export function formatMoment(date: Date): string {
  return `${moment.format(date)} UTC`;
}
