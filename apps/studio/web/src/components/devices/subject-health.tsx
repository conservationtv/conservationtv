import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';

import { StatusLabel } from '@/components/common/status';
import { statusLabels, statusOfSubject, subjectStatusesOf } from '@/components/streams/topology';
import { useOrganisationId } from '@/hooks/use-organisation';
import { organisationStatusQueryOptions } from '@/queries/organisations';

export interface SubjectHealthProps {
  /** What reports about it are filed under: `device:<id>`, `exposure:<id>` (components/devices/subjects.ts). */
  subjectId: string;
}

/**
 * A device's or an exposure's own health, as the organisation's status judges it (`organisations.status.get`): a
 * status dot and what it means, with why on hover. Unknown for a subject that status does not list. Reads the
 * organisation's status from the cache, which a page showing several starts loading once (`usePrefetchQuery`).
 */
export const SubjectHealth: FC<SubjectHealthProps> = ({ subjectId }) => {
  const organisationId = useOrganisationId();
  const statusesQuery = useSuspenseQuery({
    ...organisationStatusQueryOptions(organisationId),
    select: subjectStatusesOf
  });
  const statuses = statusesQuery.data;
  const status = statusOfSubject(statuses.own, subjectId);
  const reasons = statuses.reasons.get(subjectId) ?? [];
  return (
    <StatusLabel status={status} title={reasons.length > 0 ? reasons.join('\n') : undefined}>
      {statusLabels[status]}
    </StatusLabel>
  );
};
