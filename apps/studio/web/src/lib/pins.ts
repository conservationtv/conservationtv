import { z } from 'zod';

// The pages pinned to the app's rail on this browser: a stream or show to keep an eye on, an agent being set up. Pins belong
// to the browser, not the account, until the studio API keeps them.
//
// This module is the record's format and pure updates to it. Reading and writing go through the this-device queries
// (src/queries/this-device.ts), so the app always sees the record through TanStack Query.

const STORAGE_KEY = 'studio.pins';
/** As many as the rail shows without scrolling on a small laptop. */
export const MAX_PINS = 12;

/** What a pinned page is about, which decides its icon. */
export const PIN_KINDS = ['stream', 'show', 'camera', 'agent', 'network', 'page'] as const;

const PinsSchema = z.array(
  z.object({
    /** The page's path in the app. */
    to: z.string().startsWith('/'),
    label: z.string().min(1),
    kind: z.enum(PIN_KINDS)
  })
);
export type Pins = z.output<typeof PinsSchema>;
export type Pin = Pins[number];
export type PinKind = Pin['kind'];

/** Read the record; an unreadable value counts as no pins. */
export function readPins(): Pins {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? [] : PinsSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writePins(pins: Pins): void {
  if (pins.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  else localStorage.removeItem(STORAGE_KEY);
}

/** The pin removed if its page is pinned; otherwise added at the end, dropping the oldest beyond the most kept. */
export function withPinToggled(pins: Pins, pin: Pin): Pins {
  if (pins.some(existing => existing.to === pin.to)) return pins.filter(existing => existing.to !== pin.to);
  return [...pins, pin].slice(-MAX_PINS);
}

/** The pins without the one for a page, which is gone. */
export function withoutPin(pins: Pins, to: string): Pins {
  return pins.filter(pin => pin.to !== to);
}
