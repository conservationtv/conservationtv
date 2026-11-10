import type { FC } from 'react';
import type { AnyFieldApi } from '@tanstack/react-form';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldTitle
} from '@conservationtv/ui/components/field';
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { RadioGroup, RadioGroupItem } from '@conservationtv/ui/components/radio-group';

import { CAMERA_DRIVERS, CAMERA_STATES, CameraDriverChoiceSchema } from '@/components/cameras/cameras';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';

// A camera form's fields, each for one TanStack Form field, composed by the add and settings dialogs: the driver
// choice, then the chosen driver's own fields.

export interface CameraFieldProps {
  field: AnyFieldApi;
}

/** The driver, as a card for each: choosing one swaps the fields below it. */
export const CameraDriverField: FC<CameraFieldProps> = ({ field }) => {
  return (
    <FieldSet>
      <FieldLegend variant="label">Driver</FieldLegend>
      <RadioGroup
        className="grid-cols-2"
        value={field.state.value}
        onValueChange={value => {
          const choice = CameraDriverChoiceSchema.safeParse(value);
          if (choice.success) field.handleChange(choice.data);
        }}
      >
        {CAMERA_DRIVERS.map(choice => (
          <FieldLabel key={choice.driver} htmlFor={`driver-${choice.driver}`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{choice.label}</FieldTitle>
                <FieldDescription>{choice.description}</FieldDescription>
              </FieldContent>
              <RadioGroupItem id={`driver-${choice.driver}`} value={choice.driver} />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </FieldSet>
  );
};

/** An Axis camera's web address, which its RTSP server sits beside. */
export const AxisHostField: FC<CameraFieldProps> = ({ field }) => {
  return (
    <TextField
      field={field}
      label="Web address"
      placeholder="http://192.168.1.10"
      description="As its network reaches it. Its RTSP server is on the same host."
      autoComplete="off"
      spellCheck={false}
    />
  );
};

/** An Axis camera's RTSP port, when it isn't 554. */
export const AxisRtspPortField: FC<CameraFieldProps> = ({ field }) => {
  return <TextField field={field} label="RTSP port" placeholder="554" inputMode="numeric" autoComplete="off" />;
};

/** The resolutions an Axis camera streams, as its own settings list them. */
export const AxisResolutionsField: FC<CameraFieldProps> = ({ field }) => {
  return (
    <TextField
      field={field}
      label="Resolutions"
      placeholder="1920x1080, 1280x720, 640x360"
      description="Smaller renditions are sized from these."
      autoComplete="off"
      spellCheck={false}
    />
  );
};

/** An RTSP camera's stream. */
export const RtspUrlField: FC<CameraFieldProps> = ({ field }) => {
  return (
    <TextField
      field={field}
      label="Stream URL"
      placeholder="rtsp://192.168.1.10:554/stream"
      description="Without a username or password: those are kept apart, and never shown."
      autoComplete="off"
      spellCheck={false}
    />
  );
};

/** Whether the camera feeds its streams. */
export const CameraStateField: FC<CameraFieldProps> = ({ field }) => {
  return (
    <SelectField field={field} label="State">
      {CAMERA_STATES.map(choice => (
        <NativeSelectOption key={choice.state} value={choice.state}>
          {choice.label}
        </NativeSelectOption>
      ))}
    </SelectField>
  );
};
