// Session replay, in its own chunk: lib/sentry.ts loads it only for browsers that have consented to UI telemetry.
export { replayIntegration } from '@sentry/react-router';
