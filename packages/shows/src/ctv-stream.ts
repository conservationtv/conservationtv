import { defineSource } from '@strangecyan/vignette';
import { z } from 'zod';

/**
 * One conservation.tv stream, played over MoQ from one of its exposures. The props only say which exposure it is, never
 * how to reach it: each target asks the studio API for its own session (a relay URL carrying a short-lived token) as
 * whoever it runs as, and renews it itself, so no credential is ever in a snapshot. `size` is the frame the stream is
 * laid out at, for `fit`.
 *
 * ```tsx
 * <CtvStream organisationId={organisation} streamId={stream} exposureId={exposure} size={{ width: 1920, height: 1080 }} />
 * ```
 */
export const CtvStream = defineSource({
  kind: 'ctv-stream',
  props: z.object({
    /** The organisation the stream is in. */
    organisationId: z.uuid(),
    /** The stream. */
    streamId: z.uuid(),
    /** The exposure of it to watch: one on a gateway readers reach by MoQ. */
    exposureId: z.uuid(),
    /** The stream's frame, which the layer fits. */
    size: z.object({ width: z.number().positive(), height: z.number().positive() })
  }),
  size: props => props.size
});
