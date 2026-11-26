import { Suspense, type ComponentProps, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { WarningIcon } from '@phosphor-icons/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { unreachingOutputsOf } from '@/components/shows/unreachable';
import { useOrganisationId } from '@/hooks/use-organisation';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { showQueryOptions } from '@/queries/shows';

// What the show's controls warn of where a stream is placed (docs/shows.md, Decisions: "A cam an output cannot
// reach"): an output following the show whose agent reaches none of that stream's deliveries. The API works it out
// (`unreachable` on `organisations.shows.get`); the output still places the stream, so its card shows there.

export interface StreamReachWarningProps extends ComponentProps<'ul'> {
  showId: string;
  streamId: string;
}

/**
 * One line for each output following the show that cannot reach the stream, saying why: the one gateway it reads from,
 * or that the stream is delivered only on another site. Nothing while every output reaches it.
 */
export const StreamReachWarning: FC<StreamReachWarningProps> = ({ showId, streamId, className, ...props }) => {
  const organisationId = useOrganisationId();
  const reachQuery = useSuspenseQuery({
    ...showQueryOptions(organisationId, showId),
    select: show => ({
      outputs: unreachingOutputsOf(show, streamId),
      // The lineup lists every camera stream of the organisation: any other stream is a phone's, a PC's or OBS's.
      camera: show.lineup.some(stream => stream.streamId === streamId)
    })
  });
  const { outputs, camera } = reachQuery.data;
  if (outputs.length === 0) return null;
  const noun = camera ? 'camera' : 'stream';
  return (
    <ul className={cn('flex flex-col gap-0.5 text-custom-12 text-custom-warning', className)} {...props}>
      {outputs.map(output => (
        <li key={output.outputId} className="flex items-start gap-1">
          <WarningIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {output.name} cannot reach this {noun}:{' '}
            {output.inputGatewayId === null ? (
              `the ${noun} is delivered only on another site.`
            ) : (
              <>
                it reads only from{' '}
                <Suspense fallback="its input gateway">
                  <GatewayName gatewayId={output.inputGatewayId} />
                </Suspense>
                .
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
};

interface GatewayNameProps {
  gatewayId: string;
}

/** What a gateway is called, from the organisation's list; "its input gateway" for one it no longer has. */
const GatewayName: FC<GatewayNameProps> = ({ gatewayId }) => {
  const organisationId = useOrganisationId();
  const nameQuery = useSuspenseQuery({
    ...gatewayListQueryOptions(organisationId),
    select: gateways => gateways.find(gateway => gateway.id === gatewayId)?.name
  });
  return nameQuery.data ?? 'its input gateway';
};
