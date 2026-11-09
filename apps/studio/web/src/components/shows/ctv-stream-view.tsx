import type { CtvStream } from '@conservationtv/shows/ctv-stream';
import type { ReactSourcePlugin } from '@strangecyan/vignette/react';

import { CtvStreamSource } from '@/components/shows/ctv-stream-source';

/** Plays `ctv-stream` sources (packages/shows) in `<Stream sources>`, as the signed-in member. */
export const CtvStreamView: ReactSourcePlugin<typeof CtvStream> = {
  kind: 'ctv-stream',
  // An element rather than the component itself: a view returns a node, where `FC` may also return a promise.
  View: props => <CtvStreamSource {...props} />
};
