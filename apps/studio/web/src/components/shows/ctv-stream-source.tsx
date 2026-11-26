import { Suspense, use, useState, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { CtvStream } from '@conservationtv/shows/ctv-stream';
import { useSourceMedia, type ReactSourceViewProps } from '@strangecyan/vignette/react';

import { MonitorSoundContext } from '@/components/shows/monitor-sound';
import { MoqPlayer } from '@/components/streams/moq-player';
import { streamMoqReadQueryOptions } from '@/queries/streams';

// A `ctv-stream` source (packages/shows) in a browser: the stream it names, read over MoQ as the signed-in member, by
// whichever delivery the API chooses for a browser, with the credential the read query asks for and renews before it
// expires. Transparent whenever it has no picture (while its connection is asked for, while the player starts, when
// nothing a browser can play delivers it, while its broadcast is not announced, and while it stalls), so the card the
// show placed under it shows through. A show whose streams no browser can play is watched through its output's
// preview.
//
// Its sound goes to the stream's mixer, which applies the show's channel for it and plays it only while a stage shows
// it; the player itself stays silent. A source with no channel (`source.audio`) fetches no audio, and one placed for
// its sound alone (`video: false`) fetches no video and draws nothing.

type CtvStreamSourceProps = ReactSourceViewProps<typeof CtvStream>;

/** The source's box: nothing while its connection is asked for, then the stream. */
export const CtvStreamSource: FC<CtvStreamSourceProps> = ({ source }) => {
  return (
    <Suspense fallback={null}>
      <CtvStreamPlayer source={source} />
    </Suspense>
  );
};

type CtvStreamPlayerProps = Pick<CtvStreamSourceProps, 'source'>;

const CtvStreamPlayer: FC<CtvStreamPlayerProps> = ({ source }) => {
  const { organisationId, streamId } = source.props;
  // Read defensively: `video` is a newer prop of the kind (default true), absent from sources composed before it.
  const video = !('video' in source.props && source.props.video === false);
  const heard = source.audio !== undefined;
  const listening = use(MonitorSoundContext);
  const readQuery = useSuspenseQuery(streamMoqReadQueryOptions(organisationId, streamId));
  const read = readQuery.data;
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [audio, setAudio] = useState<MediaStream | undefined>(undefined);
  // Its sound reaches the mixer only once someone watching asked to hear the show; its picture always does.
  useSourceMedia(source.id, { audio: listening ? audio : null, video: canvas });
  // Nothing a browser can play delivers it, or there is nothing of it to play: its card shows instead.
  if ('failure' in read || (!video && !heard)) return null;
  return (
    <MoqPlayer
      ref={setCanvas}
      url={read.url}
      broadcast={read.broadcast}
      video={video}
      onAudio={heard ? setAudio : undefined}
      className="block size-full opacity-0 data-picture:opacity-100"
    />
  );
};
