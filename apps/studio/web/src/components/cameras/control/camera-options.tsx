import type { FC } from 'react';
import type { CameraAction, CameraOption } from '@conservationtv/cameras';
import { Button } from '@conservationtv/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { useCameraCommand } from '@/components/cameras/control/camera-commands';
import { optionOf, useCamera } from '@/components/cameras/control/camera-store';
import { FormError } from '@/components/common/form-error';

// What a camera has to set and to run, as the camera itself lists them: each option a select of the values it takes
// (its IR cut filter, say), each action a button (its wiper). For parts under a control session.

export interface CameraOptionSelectProps {
  option: CameraOption;
}

/**
 * One of the camera's options, set as it is chosen. It shows what the option is set to as the session's store has
 * it: the choice just made, until the camera's agent says the same, and what the agent says otherwise.
 */
export const CameraOptionSelect: FC<CameraOptionSelectProps> = ({ option }) => {
  const configure = useCameraCommand();
  const current = useCamera(state => optionOf(state, option.key));
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-custom-12 text-custom-text-secondary">{option.label}</span>
      <NativeSelect
        size="sm"
        value={current ?? ''}
        disabled={configure.isPending}
        onChange={event => configure.mutate({ kind: 'configure', key: option.key, value: event.target.value })}
      >
        {/* Until the camera says what it is set to, or if that is a value it didn't list. */}
        {(current === undefined || !option.values.includes(current)) && (
          <NativeSelectOption value={current ?? ''} disabled>
            {current ?? 'Unknown'}
          </NativeSelectOption>
        )}
        {option.values.map(value => (
          <NativeSelectOption key={value} value={value}>
            {value}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FormError error={configure.error} />
    </label>
  );
};

export interface CameraActionButtonProps {
  action: CameraAction;
}

/** One of the camera's actions, run when pressed. */
export const CameraActionButton: FC<CameraActionButtonProps> = ({ action }) => {
  const run = useCameraCommand();
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        loading={run.isPending}
        onClick={() => run.mutate({ kind: 'run', action: action.name })}
      >
        {action.label}
      </Button>
      <FormError error={run.error} />
    </div>
  );
};
