import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

import { startSentry } from '@/lib/sentry';

// React Router's default client entry, with Sentry started first so it sees the page load, the root middleware's
// handshake and every error the router catches. The app's modules never run Sentry while index.html is pre-rendered.
const sentry = startSentry();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter instrumentations={sentry.instrumentations} onError={sentry.onError} />
    </StrictMode>
  );
});
