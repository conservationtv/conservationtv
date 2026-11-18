import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useNavigate } from 'react-router';
import type { Agent, Output } from '@conservationtv/studio-sdk';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@conservationtv/ui/components/alert-dialog';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@conservationtv/ui/components/dialog';
import { FieldGroup } from '@conservationtv/ui/components/field';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { FormError } from '@/components/common/form-error';
import { EncodingSchema, NameSchema, type EncodingInput, type NameInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUnpinPage } from '@/hooks/use-unpin-page';
import { useClearOutputDevice, useDeleteOutput, useSetOutputDevice, useUpdateOutput } from '@/queries/outputs';

// What an administrator changes about an output itself, beside its forwards, previews and recorder (making one is its
// own route, output-new; what drives it is output-control): whether it exists, its name, how its programme is encoded,
// and the agent it runs on.

export interface OutputDialogProps {
  output: Output;
}

/** Renames the output; the form starts from its stored name each time the dialog opens. */
export const RenameOutputDialog: FC<OutputDialogProps> = ({ output }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateOutput(organisationId);
  const defaultValues: NameInput = { name: output.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) => dialog.mutate({ outputId: output.id, ...NameSchema.parse(value) })
  });
  const dialog = useDialog(update, { onOpen: () => form.reset() });
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Rename</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {output.name}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">{field => <TextField field={field} label="Name" autoComplete="off" />}</form.Field>
            <FormError error={update.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** The resolutions offered, as `<width>x<height>`, and what each is called. */
const RESOLUTIONS = [
  { value: '3840x2160', label: '2160p (3840 × 2160)' },
  { value: '2560x1440', label: '1440p (2560 × 1440)' },
  { value: '1920x1080', label: '1080p (1920 × 1080)' },
  { value: '1280x720', label: '720p (1280 × 720)' },
  { value: '854x480', label: '480p (854 × 480)' },
  { value: '640x360', label: '360p (640 × 360)' }
];
const FRAME_RATES = ['24', '25', '30', '50', '60'];
const KEYFRAME_INTERVALS = ['1', '2', '3', '4', '5', '10'];

/** One of a select's choices: its value, and what it says if that isn't the value itself. */
interface Choice {
  value: string;
  label?: string;
}

/** The choices, with the output's own first when it isn't one of them, so opening the form never changes it. */
function withCurrent(choices: Choice[], current: Choice): Choice[] {
  return choices.some(choice => choice.value === current.value) ? choices : [current, ...choices];
}

/** The output's encoding as the form holds it. */
function encodingInputOf(output: Output): EncodingInput {
  return {
    resolution: `${output.width}x${output.height}`,
    fps: String(output.fps),
    bitrateKbps: String(output.bitrateKbps),
    keyframeSeconds: String(output.keyframeSeconds)
  };
}

/**
 * Changes how the programme is encoded: its resolution, frame rate, bitrate and keyframe interval. The agent's OBS
 * takes it up when next it is configured, which restarts its stream.
 */
export const EncodingDialog: FC<OutputDialogProps> = ({ output }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateOutput(organisationId);
  const defaultValues = encodingInputOf(output);
  const form = useForm({
    defaultValues,
    validators: { onSubmit: EncodingSchema },
    onSubmit: ({ value }) => dialog.mutate({ outputId: output.id, ...EncodingSchema.parse(value) })
  });
  const resolutions = withCurrent(RESOLUTIONS, {
    value: defaultValues.resolution,
    label: `${output.width} × ${output.height}`
  });
  const frameRates = withCurrent(
    FRAME_RATES.map(value => ({ value })),
    { value: defaultValues.fps }
  );
  const keyframes = withCurrent(
    KEYFRAME_INTERVALS.map(value => ({ value })),
    { value: defaultValues.keyframeSeconds }
  );
  const dialog = useDialog(update, { onOpen: () => form.reset() });
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Programme encoding</DialogTitle>
            <DialogDescription>
              How OBS encodes {output.name} for every channel and preview. Changing it restarts OBS’s stream; channels
              show the holding picture meanwhile.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="resolution">
              {field => (
                <SelectField field={field} label="Resolution">
                  {resolutions.map(resolution => (
                    <NativeSelectOption key={resolution.value} value={resolution.value}>
                      {resolution.label}
                    </NativeSelectOption>
                  ))}
                </SelectField>
              )}
            </form.Field>
            <div className="grid grid-cols-2 gap-4">
              <form.Field name="fps">
                {field => (
                  <SelectField field={field} label="Frame rate">
                    {frameRates.map(rate => (
                      <NativeSelectOption key={rate.value} value={rate.value}>
                        {rate.value} a second
                      </NativeSelectOption>
                    ))}
                  </SelectField>
                )}
              </form.Field>
              <form.Field name="keyframeSeconds">
                {field => (
                  <SelectField field={field} label="Keyframes">
                    {keyframes.map(interval => (
                      <NativeSelectOption key={interval.value} value={interval.value}>
                        Every {interval.value} s
                      </NativeSelectOption>
                    ))}
                  </SelectField>
                )}
              </form.Field>
            </div>
            <form.Field name="bitrateKbps">
              {field => (
                <TextField
                  field={field}
                  label="Bitrate, in kbps"
                  inputMode="numeric"
                  autoComplete="off"
                  description="Constant. Twitch takes up to 6000; YouTube more at higher resolutions."
                />
              )}
            </form.Field>
            <FormError error={update.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Deletes the output, its device, forwards, previews and recorder, once confirmed, then goes back to the list. */
export const DeleteOutputDialog: FC<OutputDialogProps> = ({ output }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const remove = useDeleteOutput(organisationId);
  const dialog = useDialog(remove);
  const unpin = useUnpinPage();
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>Delete output</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {output.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops going out at once: its agent stops running OBS for it, and its channels go offline. Its forwards,
            previews and recorder go with it. The channels and the show it follows stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() =>
              dialog.mutate(output.id, {
                onSuccess: () => {
                  unpin();
                  navigate('..', { relative: 'path', replace: true });
                }
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export interface DeviceSelectProps {
  output: Output;
  agents: Agent[];
  /** The organisation's outputs, to say which agents already run another. */
  outputs: Output[];
}

/**
 * Chooses the agent that runs the output's OBS, in place of any other. An agent running another output isn't a
 * choice: an agent runs one OBS. Shows the choice being saved until it is.
 */
export const DeviceSelect: FC<DeviceSelectProps> = ({ output, agents, outputs }) => {
  const organisationId = useOrganisationId();
  const set = useSetOutputDevice(organisationId);
  const stored = output.device?.deviceId ?? '';
  const value = set.isPending ? set.variables.deviceId : stored;
  return (
    <div className="flex flex-col gap-1">
      <NativeSelect
        size="sm"
        aria-label={`The agent ${output.name} runs on`}
        value={value}
        disabled={set.isPending}
        onChange={event => {
          if (event.target.value) set.mutate({ outputId: output.id, deviceId: event.target.value });
        }}
      >
        {stored === '' && <NativeSelectOption value="">Choose an agent</NativeSelectOption>}
        {agents.map(agent => {
          const other = outputs.find(
            candidate => candidate.id !== output.id && candidate.device?.deviceId === agent.id
          );
          return (
            <NativeSelectOption key={agent.id} value={agent.id} disabled={other !== undefined}>
              {agent.device?.name ?? 'Unnamed agent'}
              {other ? ` (runs ${other.name})` : ''}
            </NativeSelectOption>
          );
        })}
      </NativeSelect>
      <FormError error={set.error} />
    </div>
  );
};

/** Leaves the output with no agent, once confirmed: nothing sends it out until one is chosen again. */
export const ClearDeviceDialog: FC<OutputDialogProps> = ({ output }) => {
  const organisationId = useOrganisationId();
  const clear = useClearOutputDevice(organisationId);
  const dialog = useDialog(clear);
  return (
    <AlertDialog {...dialog.props}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Clear</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop {output.name} going out?</AlertDialogTitle>
          <AlertDialogDescription>
            Its agent stops running OBS for it, so its channels go offline and its previews stop. Its forwards, previews
            and recorder stay, for when you choose an agent again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={clear.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" loading={clear.isPending} onClick={() => dialog.mutate(output.id)}>
            Stop it going out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
