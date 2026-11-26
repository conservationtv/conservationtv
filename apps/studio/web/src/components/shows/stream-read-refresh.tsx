import { useEffect, type FC } from 'react';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';

import { useOrganisationId } from '@/hooks/use-organisation';
import { liveExposureListQueryOptions, type LiveExposure } from '@/queries/publishing';
import { streamMoqReadQueryOptions, type MoqRead } from '@/queries/streams';

// A pushed stream's read (src/queries/streams.ts, streamMoqReadQueryOptions) is kept until its credential is nearly
// due, but the delivery the API chose may be one nobody publishes to yet: a phone that then goes live on another
// delivery would be dialled at the dead one for most of an hour, on the stage and in the takeover's preview alike.

/** A live delivery as the live list has it: its own ID and its stream's. */
interface LiveDelivery {
  id: string;
  streamId: string;
}

/** An exposure as the live list has it, with its own ID. */
interface ListedExposure extends LiveExposure {
  id: string;
}

/** The deliveries live now: the same array while they stay the same, however often the list is read. */
function liveDeliveries(exposures: ListedExposure[]): LiveDelivery[] {
  return exposures.filter(exposure => exposure.live === true).map(({ id, streamId }) => ({ id, streamId }));
}

/** Whether a read of a stream that is live somewhere misses it: refused, or dialling a delivery not among those live. */
function readsElsewhere(read: MoqRead, liveIds: Set<string>): boolean {
  if ('failure' in read) return true;
  return read.exposureId !== undefined && !liveIds.has(read.exposureId);
}

/**
 * Asks again for any stream's read that dials a delivery not live, or was refused, once another of its deliveries is
 * live, whenever the deliveries live change: from the live list the show's page reads anyway. Renders nothing.
 */
export const StreamReadRefresh: FC = () => {
  const organisationId = useOrganisationId();
  const client = useQueryClient();
  const liveQuery = useSuspenseQuery({ ...liveExposureListQueryOptions(organisationId), select: liveDeliveries });
  const live = liveQuery.data;
  useEffect(() => {
    // For each stream live somewhere: a read refused, or one dialling a delivery that is not among the live ones, is
    // asked again. One already reading a live delivery, or not read here at all, is left alone.
    const liveIds = new Set(live.map(delivery => delivery.id));
    for (const streamId of new Set(live.map(delivery => delivery.streamId))) {
      const { queryKey } = streamMoqReadQueryOptions(organisationId, streamId);
      const read = client.getQueryData(queryKey);
      if (read !== undefined && readsElsewhere(read, liveIds)) void client.invalidateQueries({ queryKey, exact: true });
    }
  }, [client, organisationId, live]);
  return null;
};
