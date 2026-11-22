import { useMutation } from '@tanstack/react-query';
import type { CameraPosition } from '@conservationtv/cameras';

import { useCameraControlSession } from '@/components/cameras/control/camera-control-context';
import { useOrganisationId } from '@/hooks/use-organisation';
import { presetActionMutationKey } from '@/queries/cameras';

// Sending the camera a command from one of its controls: the session's `run`, as a mutation, so the control can say
// that it is being sent and why it wasn't taken. For parts under a control session.

/**
 * Tell the camera being controlled to do something. A `drive` keeps the camera moving only while it is sent again,
 * which the loop in camera-drive-context.ts does: a control never sends one itself.
 */
export function useCameraCommand() {
  const control = useCameraControlSession();
  return useMutation({ mutationFn: control.run });
}

/**
 * Point the camera at a position saved for it. One of the things done to a camera's presets with nowhere of its own
 * to say how it went, so it goes by their key (`presetActionMutationKey`).
 */
export function useGoToPreset() {
  const organisationId = useOrganisationId();
  const control = useCameraControlSession();
  return useMutation({
    mutationKey: presetActionMutationKey(organisationId, control.cameraId),
    mutationFn: (position: CameraPosition) => control.run({ kind: 'moveTo', ...position })
  });
}
