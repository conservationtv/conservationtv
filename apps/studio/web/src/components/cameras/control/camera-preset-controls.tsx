import { createContext, use, type FC, type ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { CrosshairSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
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
import { DropdownMenuItem, DropdownMenuSeparator } from '@conservationtv/ui/components/dropdown-menu';
import { FieldGroup } from '@conservationtv/ui/components/field';
import { Spinner } from '@conservationtv/ui/components/spinner';

import { cameraPositionLineOf } from '@/components/cameras/cameras';
import { PRESET_NAME_TAKEN, type CameraPreset } from '@/components/cameras/camera-presets';
import { useGoToPreset } from '@/components/cameras/control/camera-commands';
import { useCameraControl, useCameraControlSession } from '@/components/cameras/control/camera-control-context';
import { useCameraPicture } from '@/components/cameras/control/camera-picture-context';
import { usePresetPosition } from '@/components/cameras/control/camera-store';
import { FormError } from '@/components/common/form-error';
import { PresetNameSchema, type PresetNameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { conflictAs } from '@/lib/conflict';
import { useCreatePreset, useKeepPresetPicture, useUpdatePreset } from '@/queries/cameras';

// What a camera's presets need the camera for: going to one, and saving where it points now, as a new preset or over
// an old one, with a still of what it sees as the preset's picture. Each is a part of the control layer set among the
// presets' own parts (camera-presets.tsx), and does nothing outside a control session, so the presets read the same,
// as a gallery, while the camera can't be controlled.

export interface PresetControlProps {
  preset: CameraPreset;
}

/**
 * Keeps a still of what the camera shows now as a preset's picture: for just after the preset's position is saved,
 * while the camera is still there. A camera with no video to take one from leaves the preset without, and a still
 * that can't be taken or kept is said beside the presets (`PresetNotice`), never as the save having failed.
 */
function useKeepPicture(): (presetId: string) => void {
  const organisationId = useOrganisationId();
  const control = useCameraControlSession();
  const picture = useCameraPicture();
  const keep = useKeepPresetPicture(organisationId, control.cameraId);
  return presetId => keep.mutate({ presetId, capture: () => picture?.capture() ?? null });
}

/**
 * Makes a preset's tile a button that points the camera at it: set down inside the tile, over its picture. Nothing
 * outside a control session.
 */
export const PresetGo: FC<PresetControlProps> = ({ preset }) => {
  const control = useCameraControl();
  if (!control) return null;
  return <ControlledGo preset={preset} />;
};

const ControlledGo: FC<PresetControlProps> = ({ preset }) => {
  const go = useGoToPreset();
  return (
    <button
      type="button"
      aria-label={`Go to ${preset.name}`}
      aria-busy={go.isPending || undefined}
      className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-[inherit] text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-black/10 aria-busy:bg-black/40"
      onClick={() => go.mutate(preset.position)}
    >
      {go.isPending && <Spinner className="size-5" />}
    </button>
  );
};

/** Asks to set the preset to where the camera points now, for the menu item under a `PresetOverwrite`. */
const PresetOverwriteContext = createContext<(() => void) | null>(null);

export interface PresetOverwriteProps extends PresetControlProps {
  /** The preset's menu, which offers it with a `PresetOverwriteItem`. */
  children: ReactNode;
}

/**
 * Saves where the camera points now over a preset's position, once confirmed, and takes its picture again. It holds
 * the confirmation outside the preset's menu, whose items go when it closes, and the menu asks for it with a
 * `PresetOverwriteItem`. Outside a control session it is only its children.
 */
export const PresetOverwrite: FC<PresetOverwriteProps> = ({ preset, children }) => {
  const control = useCameraControl();
  if (!control) return children;
  return <ControlledOverwrite preset={preset}>{children}</ControlledOverwrite>;
};

const ControlledOverwrite: FC<PresetOverwriteProps> = ({ preset, children }) => {
  const organisationId = useOrganisationId();
  const control = useCameraControlSession();
  const update = useUpdatePreset(organisationId);
  const keepPicture = useKeepPicture();
  const dialog = useDialog(update);
  const position = usePresetPosition();
  return (
    <PresetOverwriteContext value={() => dialog.props.onOpenChange(true)}>
      {children}
      <AlertDialog {...dialog.props}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="truncate">Set {preset.name} to here?</AlertDialogTitle>
            <AlertDialogDescription>
              Its saved position and its picture are replaced with where the camera points now
              {position ? `: ${cameraPositionLineOf(position)}.` : '.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={update.error} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              loading={update.isPending}
              disabled={!position}
              onClick={() => {
                if (!position) return;
                dialog.mutate(
                  { cameraId: control.cameraId, presetId: preset.id, position },
                  { onSuccess: () => keepPicture(preset.id) }
                );
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PresetOverwriteContext>
  );
};

/** The menu item that sets a preset to where the camera points now. Nothing unless under a `PresetOverwrite`. */
export const PresetOverwriteItem: FC = () => {
  const ask = use(PresetOverwriteContext);
  if (!ask) return null;
  return (
    <>
      <DropdownMenuItem onClick={ask}>
        <CrosshairSimpleIcon />
        Set to current position
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
};

/**
 * Saves where the camera points now as a new preset, under a name, with a still of what it sees. Nothing outside a
 * control session.
 */
export const SavePresetDialog: FC = () => {
  const control = useCameraControl();
  if (!control) return null;
  return <ControlledSaveDialog />;
};

const ControlledSaveDialog: FC = () => {
  const organisationId = useOrganisationId();
  const control = useCameraControlSession();
  const create = useCreatePreset(organisationId);
  const keepPicture = useKeepPicture();
  const position = usePresetPosition();
  const defaultValues: PresetNameInput = { name: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: PresetNameSchema },
    onSubmit: ({ value }) => {
      // The position is read as the form is sent, not as the dialog opened: the camera may have settled since.
      if (!position) return;
      dialog.mutate(
        { cameraId: control.cameraId, name: PresetNameSchema.parse(value).name, position },
        { onSuccess: preset => keepPicture(preset.id) }
      );
    }
  });
  const dialog = useDialog(create, { onOpen: () => form.reset() });
  return (
    <Dialog {...dialog.props}>
      <DialogTrigger render={<Button variant="ghost" size="sm" disabled={!position} />}>
        <PlusIcon />
        Save position
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save this position</DialogTitle>
            <DialogDescription className="tabular-nums">
              {position
                ? `Where the camera points now: ${cameraPositionLineOf(position)}. What it sees is kept as the preset’s picture.`
                : 'Waiting to hear where the camera points.'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => (
                <TextField
                  field={field}
                  label="Name"
                  placeholder="home"
                  description="What chat calls it: !ptz pond home."
                  autoComplete="off"
                />
              )}
            </form.Field>
            <FormError error={conflictAs(create.error, PRESET_NAME_TAKEN)} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending} disabled={!position}>
              Save preset
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
