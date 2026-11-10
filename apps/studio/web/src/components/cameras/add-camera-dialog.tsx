import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { Camera } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import { FieldGroup, FieldSeparator } from '@conservationtv/ui/components/field';

import {
  AxisHostField,
  AxisResolutionsField,
  AxisRtspPortField,
  CameraDriverField,
  CameraStateField,
  RtspUrlField
} from '@/components/cameras/camera-fields';
import { FormError } from '@/components/common/form-error';
import { NetworkOptions } from '@/components/devices/network-options';
import { NewCameraSchema, type NewCameraInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateCamera } from '@/queries/cameras';
import { networkListQueryOptions } from '@/queries/networks';

export interface AddCameraDialogProps {
  /** Called with the camera once it is made, before the dialog closes back to the page beneath it. */
  onAdded?: (camera: Camera) => void;
}

/**
 * Adds a camera: its name and network, how it is reached by its driver, the credentials it takes, and whether it feeds
 * its streams straight away. It is a route's dialog: open from the start, and closing back to the page beneath it, once
 * the camera is made or the dialog is dismissed.
 */
export const AddCameraDialog: FC<AddCameraDialogProps> = ({ onAdded }) => {
  const organisationId = useOrganisationId();
  const { data: networks } = useSuspenseQuery(networkListQueryOptions(organisationId));
  const create = useCreateCamera(organisationId);
  const defaultValues: NewCameraInput = {
    name: '',
    networkId: networks[0]?.id ?? '',
    driver: 'axis',
    host: '',
    rtspPort: '',
    resolutions: '',
    url: '',
    username: '',
    password: '',
    state: 'enabled'
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NewCameraSchema },
    onSubmit: ({ value }) => dialog.mutate(NewCameraSchema.parse(value), { onSuccess: camera => onAdded?.(camera) })
  });
  const dialog = useDialog(create, { closeTo: '..' });
  return (
    <Dialog {...dialog.props}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a camera</DialogTitle>
            <DialogDescription>
              The active agent on its network pulls from it, by the address you give here.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="Hide camera" autoComplete="off" />}
            </form.Field>
            <div className="grid grid-cols-2 gap-4">
              <form.Field name="networkId">
                {field => (
                  <SelectField field={field} label="Network">
                    <NetworkOptions networks={networks} />
                  </SelectField>
                )}
              </form.Field>
              <form.Field name="state">{field => <CameraStateField field={field} />}</form.Field>
            </div>
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
            <FieldSeparator>Credentials, if it asks for them</FieldSeparator>
            <div className="grid grid-cols-2 gap-4">
              <form.Field name="username">
                {field => <TextField field={field} label="Username" autoComplete="off" spellCheck={false} />}
              </form.Field>
              <form.Field name="password">
                {field => <TextField field={field} label="Password" type="password" autoComplete="new-password" />}
              </form.Field>
            </div>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add camera
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
