// How the app writes dates, durations and sizes, in the browser's locale.

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** A date, from the API's ISO timestamp: "10 Nov 2026". */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** A date and time: "10 Nov 2026, 02:14". */
export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

/** The units a span of time is written in, largest first, each with how many seconds it is. */
const SPANS = [
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 }
] as const;

/** How long ago, or how far off, a timestamp is: "3 hours ago", "in 2 days"; within a minute either way, "just now". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const span = SPANS.find(candidate => Math.abs(seconds) >= candidate.seconds);
  if (!span) return 'just now';
  return relativeFormat.format(Math.round(seconds / span.seconds), span.unit);
}

/** A length of time in its two largest units: "6d 3h", "4h 12m", "38s". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** A size in bytes, in the largest unit that keeps it at one or more: "34.4 GB". */
export function formatBytes(bytes: number): string {
  const exponent = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 || value >= 100 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

/** A device's public ID, shortened for a row: its first and last few characters. */
export function shortPublicId(publicId: string): string {
  return `${publicId.slice(0, 8)}…${publicId.slice(-4)}`;
}

/** A count and what it counts, in the singular for one: "1 camera", "3 cameras". */
export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
