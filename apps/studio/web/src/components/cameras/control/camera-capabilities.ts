import { useSuspenseQuery } from '@tanstack/react-query';
import type { CameraCapabilities } from '@conservationtv/cameras';

import { useCameraControlSession } from '@/components/cameras/control/camera-control-context';
import { useOrganisationId } from '@/hooks/use-organisation';
import { agentCameraListQueryOptions, cameraAbilityOf, type CameraAbility } from '@/queries/camera-control';

/**
 * What is known of what the camera being controlled can do, as the agent that reaches it says: that the agent
 * doesn't answer, that the camera hasn't answered it, or what the camera can do. For parts under a control session;
 * suspends until the agent has been asked once.
 */
export function useCameraAbility(): CameraAbility {
  const organisationId = useOrganisationId();
  const control = useCameraControlSession();
  const abilityQuery = useSuspenseQuery({
    ...agentCameraListQueryOptions(organisationId, control.session.agent.publicId),
    select: answer => cameraAbilityOf(answer, control.cameraId)
  });
  return abilityQuery.data;
}

/**
 * What the camera being controlled can do, for the parts that only show once that is known: null until it is
 * (`CameraNotices` says why it isn't).
 */
export function useCameraCapabilities(): CameraCapabilities | null {
  const ability = useCameraAbility();
  return ability.status === 'answered' ? ability.capabilities : null;
}
