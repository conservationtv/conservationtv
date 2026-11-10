import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useNavigate } from 'react-router';
import { PlusIcon } from '@phosphor-icons/react';
import type { Agent, Show } from '@conservationtv/studio-sdk';
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
import { useConfirm } from '@/hooks/use-confirm';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUnpinPage } from '@/hooks/use-unpin-page';
import { useClearShowOutput, useCreateShow, useDeleteShow, useSetShowOutput, useUpdateShow } from '@/queries/shows';

// What an administrator changes about a show itself, beside its forwards, previews and recorder: whether it exists,
// its name, how its programme is encoded, and the agent that sends it out.

/** Makes a show by name, its programme at the default encoding, then opens it. */
export const NewShowDialog: FC = () => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const create = useCreateShow(organisationId);
  const defaultValues: NameInput = { name: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) => create.mutate(NameSchema.parse(value), { onSuccess: show => navigate(show.id) })
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) return;
        create.reset();
        form.reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon />
        New show
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New show</DialogTitle>
            <DialogDescription>
              It follows the organisation’s broadcast, at 1080p and 30 frames a second until you change it. Choose the
              agent that sends it out, and the channels it goes to, on its page.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Waterhole, evenings" autoComplete="off" />}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Create show
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export interface ShowDialogProps {
  show: Show;
}

/** Renames the show; the form starts from its stored name each time the dialog opens. */
export const RenameShowDialog: FC<ShowDialogProps> = ({ show }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateShow(organisationId);
  const defaultValues: NameInput = { name: show.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NameSchema },
    onSubmit: ({ value }) =>
      update.mutate({ showId: show.id, ...NameSchema.parse(value) }, { onSuccess: () => setOpen(false) })
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) return;
        update.reset();
        form.reset();
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Rename</DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {show.name}</DialogTitle>
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

/** The choices, with the show's own first when it isn't one of them, so opening the form never changes it. */
function withCurrent(choices: Choice[], current: Choice): Choice[] {
  return choices.some(choice => choice.value === current.value) ? choices : [current, ...choices];
}

/** The show's encoding as the form holds it. */
function encodingInputOf(show: Show): EncodingInput {
  return {
    resolution: `${show.width}x${show.height}`,
    fps: String(show.fps),
    bitrateKbps: String(show.bitrateKbps),
    keyframeSeconds: String(show.keyframeSeconds)
  };
}

/**
 * Changes how the programme is encoded: its resolution, frame rate, bitrate and keyframe interval. The output agent's
 * OBS takes it up when next it is configured, which restarts its stream.
 */
export const EncodingDialog: FC<ShowDialogProps> = ({ show }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateShow(organisationId);
  const defaultValues = encodingInputOf(show);
  const form = useForm({
    defaultValues,
    validators: { onSubmit: EncodingSchema },
    onSubmit: ({ value }) =>
      update.mutate({ showId: show.id, ...EncodingSchema.parse(value) }, { onSuccess: () => setOpen(false) })
  });
  const resolutions = withCurrent(RESOLUTIONS, {
    value: defaultValues.resolution,
    label: `${show.width} × ${show.height}`
  });
  const frameRates = withCurrent(
    FRAME_RATES.map(value => ({ value })),
    { value: defaultValues.fps }
  );
  const keyframes = withCurrent(
    KEYFRAME_INTERVALS.map(value => ({ value })),
    { value: defaultValues.keyframeSeconds }
  );
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) return;
        update.reset();
        form.reset();
      }}
    >
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
              How OBS encodes {show.name} for every channel and preview. Changing it restarts OBS’s stream; channels
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

/** Deletes the show, its output, forwards, previews and recorder, once confirmed, then goes back to the list. */
export const DeleteShowDialog: FC<ShowDialogProps> = ({ show }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const remove = useDeleteShow(organisationId);
  const confirmation = useConfirm(remove);
  const unpin = useUnpinPage();
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>Delete show</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {show.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It stops going out at once: its agent stops running OBS for it, and its channels go offline. Its forwards,
            previews and recorder go with it. The channels and the broadcast stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() =>
              confirmation.confirm(show.id, {
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

export interface OutputSelectProps {
  show: Show;
  agents: Agent[];
  /** The organisation's shows, to say which agents already send another out. */
  shows: Show[];
}

/**
 * Chooses the agent that runs OBS for the show, in place of any other. An agent sending another show out isn't a
 * choice: an agent runs OBS for one show. Shows the choice being saved until it is.
 */
export const OutputSelect: FC<OutputSelectProps> = ({ show, agents, shows }) => {
  const organisationId = useOrganisationId();
  const set = useSetShowOutput(organisationId);
  const stored = show.output?.deviceId ?? '';
  const value = set.isPending ? set.variables.deviceId : stored;
  return (
    <div className="flex flex-col gap-1">
      <NativeSelect
        size="sm"
        aria-label={`The agent that sends ${show.name} out`}
        value={value}
        disabled={set.isPending}
        onChange={event => {
          if (event.target.value) set.mutate({ showId: show.id, deviceId: event.target.value });
        }}
      >
        {stored === '' && <NativeSelectOption value="">Choose an agent</NativeSelectOption>}
        {agents.map(agent => {
          const other = shows.find(candidate => candidate.id !== show.id && candidate.output?.deviceId === agent.id);
          return (
            <NativeSelectOption key={agent.id} value={agent.id} disabled={other !== undefined}>
              {agent.device?.name ?? 'Unnamed agent'}
              {other ? ` (sends ${other.name} out)` : ''}
            </NativeSelectOption>
          );
        })}
      </NativeSelect>
      <FormError error={set.error} />
    </div>
  );
};

/** Leaves the show with no output agent, once confirmed: nothing sends it out until one is chosen again. */
export const ClearOutputDialog: FC<ShowDialogProps> = ({ show }) => {
  const organisationId = useOrganisationId();
  const clear = useClearShowOutput(organisationId);
  const confirmation = useConfirm(clear);
  return (
    <AlertDialog {...confirmation.dialog}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>Clear</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Stop {show.name} going out?</AlertDialogTitle>
          <AlertDialogDescription>
            Its agent stops running OBS for it, so its channels go offline and its previews stop. Its forwards, previews
            and recorder stay, for when you choose an agent again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={clear.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={clear.isPending}
            onClick={() => confirmation.confirm(show.id)}
          >
            Stop it going out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
