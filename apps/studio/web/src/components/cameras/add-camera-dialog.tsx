import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { PlusIcon } from '@phosphor-icons/react';
import type { Network } from '@conservationtv/studio-sdk';
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
import { useOrganisationId } from '@/hooks/use-organisation';
import { useCreateCamera } from '@/queries/cameras';

export interface AddCameraDialogProps {
  /** The networks the camera can be on. */
  networks: Network[];
}

/**
 * Adds a camera: its name and network, how it is reached by its driver, the credentials it takes, and whether it feeds
 * its streams straight away. The dialog closes once it is made.
 */
export const AddCameraDialog: FC<AddCameraDialogProps> = ({ networks }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
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
    onSubmit: ({ value, formApi }) =>
      create.mutate(NewCameraSchema.parse(value), {
        onSuccess: () => {
          formApi.reset();
          setOpen(false);
        }
      })
  });
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon />
        Add camera
      </DialogTrigger>
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
