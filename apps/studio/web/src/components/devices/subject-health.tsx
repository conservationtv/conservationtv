import type { FC } from 'react';

import { StatusLabel } from '@/components/common/status';
import { healthOf, type SubjectState } from '@/components/devices/subjects';
import { ownStatus } from '@/components/streams/topology';

export interface SubjectHealthProps {
  /** What agents last said about the subject: undefined when nothing has been said yet. */
  state: SubjectState | undefined;
}

/** A device's or an exposure's health, as a status dot and what it means. */
export const SubjectHealth: FC<SubjectHealthProps> = ({ state }) => {
  return <StatusLabel status={ownStatus(state)}>{healthOf(state)}</StatusLabel>;
};
