import { useState, type ComponentProps, type FC, type ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutationState } from '@tanstack/react-query';
import { DotsThreeIcon, ImageBrokenIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import type { Camera } from '@conservationtv/studio-sdk';
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
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@conservationtv/ui/components/dropdown-menu';
import { FieldGroup } from '@conservationtv/ui/components/field';
import { ScrollArea } from '@conservationtv/ui/components/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import { cameraPositionLineOf, presetThumbnailUrlOf } from '@/components/cameras/cameras';
import { FormError } from '@/components/common/form-error';
import { PresetNameSchema, type PresetNameInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useOrganisationId } from '@/hooks/use-organisation';
import { conflictAs } from '@/lib/conflict';
import { presetActionMutationKey, useDeletePreset, useRemovePresetPicture, useUpdatePreset } from '@/queries/cameras';

// A camera's presets: positions saved under a name, which chat commands and the camera's controls point it at, each
// with a picture of what the camera saw from it where one was kept. What is here only reads and manages what the
// studio keeps: the presets as a grid of tiles, and renaming one, deleting it or removing its picture. Going to a
// preset, or saving where the camera points now, needs the camera itself, and belongs to its control layer
// (control/camera-preset-controls.tsx), whose parts are set down inside these:
//
//   <PresetGrid>
//     <PresetTile preset={preset}>
//       <PresetPicture cameraId={camera.id} preset={preset} />
//       <PresetGo preset={preset} />
//       <PresetMenu cameraId={camera.id} preset={preset}>…</PresetMenu>
//     </PresetTile>
//   </PresetGrid>

export type CameraPreset = Camera['presets'][number];

/** What a failed save says when the camera already has a preset of the name. */
export const PRESET_NAME_TAKEN = 'This camera already has a preset called that.';

/** The presets as tiles in two rows, in a scroll area that goes sideways once there are more than fit. */
export const PresetGrid: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return (
    <ScrollArea className={className}>
      <div className="grid w-max auto-cols-[6.35rem] grid-flow-col grid-rows-2 content-start gap-2 p-2" {...props} />
    </ScrollArea>
  );
};

export interface PresetTileProps extends ComponentProps<'div'> {
  preset: CameraPreset;
}

/**
 * A preset as a tile: its picture, and over it whatever the page offers to do with it. What it is called, and the
 * position saved under it, show on hover.
 */
export const PresetTile: FC<PresetTileProps> = ({ preset, className, children, ...props }) => {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn('group/preset relative aspect-3/2 overflow-hidden rounded-lg bg-muted', className)}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0">
        <span className="font-medium">{preset.name}</span>
        <span className="tabular-nums opacity-70">{cameraPositionLineOf(preset.position)}</span>
      </TooltipContent>
    </Tooltip>
  );
};

export interface PresetPictureProps {
  cameraId: string;
  preset: CameraPreset;
}

/** A preset's thumbnail, filling its tile; its name on a plain ground when it has none, or it can't be shown. */
export const PresetPicture: FC<PresetPictureProps> = ({ cameraId, preset }) => {
  const organisationId = useOrganisationId();
  const url = presetThumbnailUrlOf(organisationId, cameraId, preset);
  // Keyed by its address, so a picture that failed to load is tried again once it is replaced.
  if (url !== undefined) return <PresetImage key={url} url={url} name={preset.name} />;
  return <PresetPlaceholder>{preset.name}</PresetPlaceholder>;
};

interface PresetImageProps {
  url: string;
  name: string;
}

const PresetImage: FC<PresetImageProps> = ({ url, name }) => {
  const [failed, setFailed] = useState(false);
  if (failed) return <PresetPlaceholder>{name}</PresetPlaceholder>;
  return (
    <img
      src={url}
      // The studio API is another origin, and reads the picture by the session's cookie.
      crossOrigin="use-credentials"
      alt=""
      loading="lazy"
      draggable={false}
      className="size-full object-cover"
      onError={() => setFailed(true)}
    />
  );
};

const PresetPlaceholder: FC<ComponentProps<'span'>> = ({ children, ...props }) => {
  return (
    <span
      className="flex size-full items-center justify-center p-2 text-center text-custom-12 text-muted-foreground"
      {...props}
    >
      <span className="line-clamp-2">{children}</span>
    </span>
  );
};

export interface PresetNoticeProps extends ComponentProps<'p'> {
  cameraId: string;
}

/**
 * Why the last thing done to the camera's presets from their tiles didn't work, if it didn't: going to one, or
 * keeping or removing its picture. None of them has a dialog to say so in, so each goes by one key, and the last is
 * read here from the mutation cache. Nothing once the next one works.
 */
export const PresetNotice: FC<PresetNoticeProps> = ({ cameraId, className, ...props }) => {
  const organisationId = useOrganisationId();
  const states = useMutationState({
    filters: { mutationKey: presetActionMutationKey(organisationId, cameraId) },
    select: mutation => mutation.state
  });
  const last = states.toSorted((earlier, later) => earlier.submittedAt - later.submittedAt).at(-1);
  if (last?.status !== 'error' || last.error === null) return null;
  return (
    <p role="status" className={cn('px-3 pb-3 text-custom-12 text-destructive', className)} {...props}>
      {last.error.message}
    </p>
  );
};

/** Which of a preset's dialogs its menu has open. */
type PresetDialog = 'rename' | 'delete';

export interface PresetMenuProps {
  cameraId: string;
  preset: CameraPreset;
  /** More to do with the preset, as menu items, ahead of what the studio itself offers. */
  children?: ReactNode;
}

/**
 * What an administrator does with a preset, behind a small button at its tile's corner so the grid stays pictures:
 * rename it, remove its picture, delete it, and whatever the page adds. The dialogs are set beside the menu rather
 * than in it, since the menu's items go when it closes.
 */
export const PresetMenu: FC<PresetMenuProps> = ({ cameraId, preset, children }) => {
  const organisationId = useOrganisationId();
  const removePicture = useRemovePresetPicture(organisationId, cameraId);
  const [dialog, setDialog] = useState<PresetDialog | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="secondary"
              size="icon-xs"
              aria-label={`Manage ${preset.name}`}
              className="absolute top-1 right-1 opacity-0 shadow-sm group-hover/preset:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
            />
          }
        >
          <DotsThreeIcon weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-44">
          {children}
          <DropdownMenuItem onClick={() => setDialog('rename')}>
            <PencilSimpleIcon />
            Rename
          </DropdownMenuItem>
          {preset.thumbnail !== null && (
            <DropdownMenuItem onClick={() => removePicture.mutate(preset.id)}>
              <ImageBrokenIcon />
              Remove thumbnail
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog('delete')}>
            <TrashIcon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenamePresetDialog
        cameraId={cameraId}
        preset={preset}
        open={dialog === 'rename'}
        onOpenChange={open => setDialog(open ? 'rename' : null)}
      />
      <DeletePresetDialog
        cameraId={cameraId}
        preset={preset}
        open={dialog === 'delete'}
        onOpenChange={open => setDialog(open ? 'delete' : null)}
      />
    </>
  );
};

export interface PresetDialogProps {
  cameraId: string;
  preset: CameraPreset;
  /** Opened and closed by whatever offers it: these dialogs have no trigger of their own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Renames a preset. Chat commands name presets by what they are called, so one that named it finds it gone. */
export const RenamePresetDialog: FC<PresetDialogProps> = ({ cameraId, preset, open, onOpenChange }) => {
  const organisationId = useOrganisationId();
  const update = useUpdatePreset(organisationId);
  const defaultValues: PresetNameInput = { name: preset.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: PresetNameSchema },
    onSubmit: ({ value }) =>
      update.mutate(
        { cameraId, presetId: preset.id, name: PresetNameSchema.parse(value).name },
        { onSuccess: () => onOpenChange(false) }
      )
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        onOpenChange(next);
        // It was opened from outside, so it is as it closes that it is made ready to open clean.
        if (next) return;
        update.reset();
        form.reset();
      }}
    >
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate">Rename {preset.name}</DialogTitle>
            <DialogDescription>
              Chat commands name a preset by what it is called: one that names this preset needs changing too.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">{field => <TextField field={field} label="Name" autoComplete="off" />}</form.Field>
            <FormError error={conflictAs(update.error, PRESET_NAME_TAKEN)} />
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

/** Removes a preset, once confirmed. */
export const DeletePresetDialog: FC<PresetDialogProps> = ({ cameraId, preset, open, onOpenChange }) => {
  const organisationId = useOrganisationId();
  const remove = useDeletePreset(organisationId);
  return (
    <AlertDialog
      open={open}
      onOpenChange={next => {
        onOpenChange(next);
        if (!next) remove.reset();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="truncate">Delete {preset.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            A chat command that names this preset will find nothing to point the camera at.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={remove.isPending}
            onClick={() => remove.mutate({ cameraId, presetId: preset.id }, { onSuccess: () => onOpenChange(false) })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
