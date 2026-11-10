import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import type { Camera } from '@conservationtv/studio-sdk';
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

import {
  AxisHostField,
  AxisResolutionsField,
  AxisRtspPortField,
  CameraDriverField,
  RtspUrlField
} from '@/components/cameras/camera-fields';
import { cameraSettingsInputOf } from '@/components/cameras/cameras';
import { FormError } from '@/components/common/form-error';
import { CameraSettingsSchema } from '@/forms/schemas';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUpdateCamera } from '@/queries/cameras';

export interface CameraSettingsDialogProps {
  camera: Camera;
  /** What the camera is called, for the dialog's title. */
  name: string;
}

/**
 * Changes how a camera is reached: its driver and that driver's fields, replaced whole. Its credentials are kept. The
 * form starts from what is stored each time it opens.
 */
export const CameraSettingsDialog: FC<CameraSettingsDialogProps> = ({ camera, name }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateCamera(organisationId);
  const form = useForm({
    defaultValues: cameraSettingsInputOf(camera.settings),
    validators: { onSubmit: CameraSettingsSchema },
    onSubmit: ({ value }) =>
      update.mutate(
        { cameraId: camera.id, settings: CameraSettingsSchema.parse(value) },
        { onSuccess: () => setOpen(false) }
      )
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
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate">How {name} is reached</DialogTitle>
            <DialogDescription>
              Its streams pick the change up the next time its network’s agent is configured.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="driver">{field => <CameraDriverField field={field} />}</form.Field>
            <form.Subscribe selector={state => state.values.driver}>
              {driver =>
                driver === 'axis' ? (
                  <>
                    <form.Field name="host">{field => <AxisHostField field={field} />}</form.Field>
                    <div className="grid grid-cols-[1fr_2fr] items-start gap-4">
                      <form.Field name="rtspPort">{field => <AxisRtspPortField field={field} />}</form.Field>
                      <form.Field name="resolutions">{field => <AxisResolutionsField field={field} />}</form.Field>
                    </div>
                  </>
                ) : (
                  <form.Field name="url">{field => <RtspUrlField field={field} />}</form.Field>
                )
              }
            </form.Subscribe>
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
