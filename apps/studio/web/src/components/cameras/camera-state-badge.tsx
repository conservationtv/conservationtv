import type { FC } from 'react';
import { Badge } from '@conservationtv/ui/components/badge';

import { cameraStateDetailsOf, type CameraState } from '@/components/cameras/cameras';

export interface CameraStateBadgeProps {
  state: CameraState;
}

/** A camera's state: quiet while it is enabled, outlined while it is kept from feeding its streams. */
export const CameraStateBadge: FC<CameraStateBadgeProps> = ({ state }) => {
  const details = cameraStateDetailsOf(state);
  return <Badge variant={state === 'enabled' ? 'secondary' : 'outline'}>{details.label}</Badge>;
};
