// Whoever uses this browser has agreed to optional UI telemetry: breadcrumbs of what they click and type into, and
// session replays of errors. Errors and traces are reported without it; see lib/sentry.ts. Off until granted, and kept
// per browser, like the theme. Sentry reads it once, when the app loads, so a change applies from the next load.

const STORAGE_KEY = 'studio.telemetry-consent';

/** Whether this browser has granted consent; unreadable storage counts as not. */
export function hasTelemetryConsent(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'granted';
  } catch {
    return false;
  }
}

/** Record this browser's choice. Nothing asks for it yet. */
export function setTelemetryConsent(granted: boolean): void {
  if (granted) {
    localStorage.setItem(STORAGE_KEY, 'granted');
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}
