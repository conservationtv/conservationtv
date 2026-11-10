import type { FC } from 'react';
import type { Camera } from '@conservationtv/studio-sdk';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { CAMERA_STATES, cameraStateOf } from '@/components/cameras/cameras';
import { FormError } from '@/components/common/form-error';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUpdateCamera } from '@/queries/cameras';

export interface CameraStateSelectProps {
  camera: Camera;
  /** What the camera is called, for the select's label. */
  name: string;
}

/** Chooses whether the camera feeds its streams, saved as it is chosen. Shows the choice being saved until it is. */
export const CameraStateSelect: FC<CameraStateSelectProps> = ({ camera, name }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateCamera(organisationId);
  const value = update.isPending ? (update.variables.state ?? camera.state) : camera.state;
  return (
    <>
      <NativeSelect
        size="sm"
        aria-label={`State of ${name}`}
        value={value}
        disabled={update.isPending}
        onChange={event => {
          const state = cameraStateOf(event.target.value);
          if (state) update.mutate({ cameraId: camera.id, state });
        }}
      >
        {CAMERA_STATES.map(choice => (
          <NativeSelectOption key={choice.state} value={choice.state}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FormError error={update.error} />
    </>
  );
};
