import type { FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import { FieldGroup } from '@conservationtv/ui/components/field';

import type { Route } from './+types/channel-rtmp-new';
import { FormError } from '@/components/common/form-error';
import { RtmpChannelSchema, type RtmpChannelInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import { useDialog } from '@/hooks/use-dialog';
import { useCreateRtmpChannel } from '@/queries/channels';

export const meta: Route.MetaFunction = () => [{ title: 'Add an RTMP destination · conservation.tv studio' }];

/**
 * Adding any RTMP(S) destination by hand (YouTube, a second Twitch account, a restreaming service), as a dialog over
 * the channels page at `channels/rtmp/new`, closing back to it once it is made.
 */
const ChannelRtmpNewRoute: FC<Route.ComponentProps> = ({ params }) => {
  const { organisationId } = params;
  const create = useCreateRtmpChannel(organisationId);
  const defaultValues: RtmpChannelInput = { name: '', url: '', key: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: RtmpChannelSchema },
    onSubmit: ({ value }) => dialog.mutate(RtmpChannelSchema.parse(value))
  });
  const dialog = useDialog(create, { closeTo: '../..' });
  return (
    <Dialog {...dialog.props}>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add an RTMP destination</DialogTitle>
            <DialogDescription>
              The server URL and stream key from the service’s streaming settings. The key is kept encrypted and isn’t
              shown again.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <form.Field name="name">
              {field => <TextField field={field} label="Name" placeholder="YouTube" autoComplete="off" />}
            </form.Field>
            <form.Field name="url">
              {field => (
                <TextField
                  field={field}
                  label="Server URL"
                  placeholder="rtmps://a.rtmp.youtube.com/live2"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </form.Field>
            <form.Field name="key">
              {field => (
                <TextField field={field} label="Stream key" type="password" autoComplete="off" spellCheck={false} />
              )}
            </form.Field>
            <FormError error={create.error} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" loading={create.isPending}>
              Add destination
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default ChannelRtmpNewRoute;
