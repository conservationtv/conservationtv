// How a metric's value is written for people, in its unit: one way for the studio API's health findings and the web
// app's charts alike. Written with `Intl.NumberFormat`, in `locale` (the runtime's when undefined): the API writes its
// findings in English, the browser in its reader's locale.

/** Formats, kept per locale and options: making one is far slower than using it. */
const formats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify([locale, options]);
  const known = formats.get(key);
  if (known !== undefined) return known;
  const format = new Intl.NumberFormat(locale, options);
  formats.set(key, format);
  return format;
}

/** The units a bitrate is written in, largest first, each with how many bits a second it is. */
const BITRATE_SCALES = [
  { unit: 'gigabit-per-second', bits: 1e9, digits: 1 },
  { unit: 'megabit-per-second', bits: 1e6, digits: 1 },
  { unit: 'kilobit-per-second', bits: 1e3, digits: 0 }
] as const;

/** A metric's value in its unit (`MetricDefinition['unit']`): `2.4 Mb/s`, `62%`, `2 min`, `12 frames/s`. */
export function formatMetric(value: number, unit: string, locale?: string): string {
  if (unit === 'boolean') return formatShare(value, locale);
  if (unit === 'bits/s') return formatBitrate(value, locale);
  if (unit === 'seconds') return formatSeconds(value, locale);
  if (unit === 'percent') {
    const percent = numberFormat(locale, { style: 'unit', unit: 'percent', maximumFractionDigits: 0 });
    return percent.format(value);
  }
  if (unit === 'ratio') {
    const ratio = numberFormat(locale, { maximumFractionDigits: 2 });
    return ratio.format(value);
  }
  // A unit `Intl` has no name for, such as frames a second or viewers: the number, then the unit as given.
  const plain = numberFormat(locale, { maximumFractionDigits: 1 });
  return `${plain.format(value)} ${unit}`;
}

/** A share from 0 to 1, such as how much of a window a `boolean` metric held: `62%`. */
export function formatShare(share: number, locale?: string): string {
  const percent = numberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  return percent.format(share);
}

/** Bits a second, in the largest unit that keeps it at one or more: `2.4 Mb/s`, `640 kb/s`. */
export function formatBitrate(bits: number, locale?: string): string {
  const scale = BITRATE_SCALES.find(candidate => Math.abs(bits) >= candidate.bits);
  const unit = scale?.unit ?? 'bit-per-second';
  const digits = scale?.digits ?? 0;
  const value = bits / (scale?.bits ?? 1);
  const bitrate = numberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits });
  return bitrate.format(value);
}

/** A span of seconds, in whole minutes where it is some: `2 min`, `45 sec`. */
export function formatSeconds(seconds: number, locale?: string): string {
  const minutes = seconds >= 60 && seconds % 60 === 0;
  const unit = minutes ? 'minute' : 'second';
  const value = minutes ? seconds / 60 : seconds;
  const span = numberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 });
  return span.format(value);
}
