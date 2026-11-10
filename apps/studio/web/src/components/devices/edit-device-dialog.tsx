import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
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
import { FieldGroup } from '@conservationtv/ui/components/field';

import { FormError } from '@/components/common/form-error';
import type { DeviceKind } from '@/components/devices/device-kind';
import { NetworkOptions } from '@/components/devices/network-options';
import { DeviceDetailsSchema, type DeviceDetailsInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useUpdateDevice } from '@/queries/devices';

/** The parts of a device this dialog edits. */
export interface EditableDevice {
  id: string;
  kind: DeviceKind;
  name: string;
  networkId: string | null;
}

export interface EditDeviceDialogProps {
  device: EditableDevice;
  /** The networks a camera can be moved to. */
  networks: Network[];
}

/** What can change about each kind of device, and why. */
const editNotes = {
  camera: 'Move a camera to the network it is plugged into: that network’s active agent pulls from it.',
  agent: 'An agent stays on the network it was set up on, so only its name changes here.',
  browser: 'A browser stays on the internet, so only its name changes here.'
} satisfies Record<DeviceKind, string>;

/**
 * Renames a device and, for a camera, moves it to another network. An agent stays on the network it was set up on and
 * a browser on the internet, so only their names change here. The form starts from what is stored each time it opens.
 */
export const EditDeviceDialog: FC<EditDeviceDialogProps> = ({ device, networks }) => {
  const organisationId = useOrganisationId();
  const [open, setOpen] = useState(false);
  const update = useUpdateDevice(organisationId);
  const movable = device.kind === 'camera';
  const defaultValues: DeviceDetailsInput = { name: device.name, networkId: device.networkId ?? '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: DeviceDetailsSchema },
    onSubmit: ({ value }) => {
      const { name, networkId } = DeviceDetailsSchema.parse(value);
      const changes = movable ? { deviceId: device.id, name, networkId } : { deviceId: device.id, name };
      update.mutate(changes, { onSuccess: () => setOpen(false) });
    }
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
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate">Edit {device.name}</DialogTitle>
            <DialogDescription>{editNotes[device.kind]}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">{field => <TextField field={field} label="Name" autoComplete="off" />}</form.Field>
            {movable && (
              <form.Field name="networkId">
                {field => (
                  <SelectField field={field} label="Network">
                    <NetworkOptions networks={networks} />
                  </SelectField>
                )}
              </form.Field>
            )}
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
