import { Suspense, type FC, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { CtvStream } from '@conservationtv/shows/ctv-stream';
import type { ReactSourceViewProps } from '@strangecyan/vignette/react';

import { MoqPlayer } from '@/components/streams/moq-player';
import { moqReadQueryOptions } from '@/queries/streams';

// A `ctv-stream` source (packages/shows) in a browser: the exposure it names, read over MoQ as the signed-in member,
// with the credential the read query asks for and renews before it expires.

type CtvStreamSourceProps = ReactSourceViewProps<typeof CtvStream>;

/** The source's box: black while its connection is asked for, then the stream. */
export const CtvStreamSource: FC<CtvStreamSourceProps> = ({ source }) => {
  return (
    <Suspense fallback={<SourceBox />}>
      <CtvStreamPlayer source={source} />
    </Suspense>
  );
};

type CtvStreamPlayerProps = Pick<CtvStreamSourceProps, 'source'>;

const CtvStreamPlayer: FC<CtvStreamPlayerProps> = ({ source }) => {
  const { organisationId, streamId, exposureId } = source.props;
  const readQuery = useSuspenseQuery(moqReadQueryOptions(organisationId, streamId, exposureId));
  const read = readQuery.data;
  if ('failure' in read) return <SourceBox>Stream unavailable: {read.failure}</SourceBox>;
  return <MoqPlayer url={read.url} broadcast={read.broadcast} className="block size-full bg-black" />;
};

interface SourceBoxProps {
  children?: ReactNode;
}

const SourceBox: FC<SourceBoxProps> = ({ children }) => {
  return (
    <div className="flex size-full items-center justify-center bg-black px-12 text-center text-4xl text-white/70">
      {children}
    </div>
  );
};
