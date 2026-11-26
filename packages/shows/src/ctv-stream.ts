import { defineSource } from '@strangecyan/vignette';
import { z } from 'zod';

/**
 * One conservation.tv stream. The props only say which stream it is, never what delivers it or how to reach it: each
 * target asks the studio API how it should read the stream (`organisations.streams.connect`) as whoever it runs as,
 * and renews that itself, so no credential or delivery is ever in a snapshot and a change of delivery never changes the
 * show. `size` is the frame the stream is laid out at, for `fit`. While it has no picture, a target shows nothing, so
 * whatever the show placed under it shows through.
 *
 * A stream carries sound, so it has an audio channel (vignette's `audio` prop), unless it is placed with
 * `audio={false}`, when a target need not fetch its sound at all. With `video={false}` it is placed for its sound alone:
 * it takes no space, and a target need not fetch its picture.
 *
 * `exposureId` is only for agents from before that (see the prop): they build their input from it and ask for that
 * exposure. Targets since ignore it.
 *
 * ```tsx
 * <CtvStream organisationId={organisation} streamId={stream} size={{ width: 1920, height: 1080 }} />
 * <CtvStream organisationId={organisation} streamId={stream} size={{ width: 1920, height: 1080 }} video={false} />
 * ```
 */
export const CtvStream = defineSource({
  kind: 'ctv-stream',
  props: z.object({
    /** The organisation the stream is in. */
    organisationId: z.uuid(),
    /** The stream. */
    streamId: z.uuid(),
    /**
     * Deprecated: the stream's conservation.tv exposure, when it has one, for agents built before a source named only
     * its stream, which read that exposure by MoQ. Nothing since reads it.
     */
    exposureId: z.uuid().optional(),
    /** The stream's frame, which the layer fits. */
    size: z.object({ width: z.number().positive(), height: z.number().positive() }),
    /** Whether its picture is placed: false for a stream placed only to be heard. */
    video: z.boolean().default(true)
  }),
  size: props => props.size,
  media: props => ({ audio: true, video: props.video })
});
