import { useState, type FC } from 'react';
import { useForm } from '@tanstack/react-form';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { BroadcastIcon, PlusIcon, TwitchLogoIcon } from '@phosphor-icons/react';
import type { Channel } from '@conservationtv/studio-sdk';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import { Badge } from '@conservationtv/ui/components/badge';
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { FieldGroup } from '@conservationtv/ui/components/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { Switch } from '@conservationtv/ui/components/switch';

import type { Route } from './+types/channels';
import { FormError } from '@/components/common/form-error';
import { RtmpChannelSchema, type RtmpChannelInput } from '@/forms/schemas';
import { TextField } from '@/forms/text-field';
import {
  channelListQueryOptions,
  useConnectTwitch,
  useCreateRtmpChannel,
  useDeleteChannel,
  useSetChannelEnabled
} from '@/queries/channels';

export const meta: Route.MetaFunction = () => [{ title: 'Channels · conservation.tv studio' }];

/** What the API's Twitch callback says happened, by its `?error=`. */
const CONNECT_ERRORS = new Map([
  ['expired', 'The connection took too long, or was started by someone else. Try again.'],
  ['refused', 'Twitch didn’t give the studio access. Try again, and approve it on Twitch.']
]);
/** Any other failure: Twitch, or keeping what it gave, failed. */
const CONNECT_FAILED = 'Twitch couldn’t be reached, or didn’t answer as expected. Try again in a moment.';

/**
 * Where the organisation's broadcast goes out to: Twitch channels, connected on Twitch, and any RTMP(S) destination by
 * its server URL and stream key. The show's output agent forwards the program to every channel that is on. Stream keys
 * are never shown again once saved: only the output agent reads them.
 */
const ChannelsRoute: FC<Route.ComponentProps> = ({ params }) => {
  const { organisationId } = params;
  const list = useSuspenseQuery(channelListQueryOptions(organisationId));
  const { channels, twitch } = list.data;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-10 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-custom-21 font-semibold text-foreground">Channels</h1>
        <p className="max-w-2xl text-custom-13 leading-(--leading-custom-body) text-custom-text-secondary">
          Where the show goes out to. The show’s output sends the broadcast to every channel that’s on, and keeps them
          live with a holding picture while OBS restarts.
        </p>
      </header>
      <ConnectOutcome />
      <div className="flex flex-wrap items-center gap-2">
        <ConnectTwitchButton organisationId={organisationId} enabled={twitch} />
        <AddRtmpDialog organisationId={organisationId} />
      </div>
      {channels.length ? (
        <ItemGroup className="gap-2">
          {channels.map(channel => (
            <ChannelRow key={channel.id} organisationId={organisationId} channel={channel} />
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BroadcastIcon />
            </EmptyMedia>
            <EmptyTitle>No channels yet</EmptyTitle>
            <EmptyDescription>
              Connect a Twitch channel, or add an RTMP destination, to send the show out.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
};

export default ChannelsRoute;

/** The outcome of connecting Twitch, which the API's callback returns with; dismissed by clearing it from the URL. */
const ConnectOutcome: FC = () => {
  const [search, setSearch] = useSearchParams();
  const error = search.get('error');
  const connected = search.get('connected');
  if (!error && !connected) return null;
  const dismiss = () => setSearch({}, { replace: true });
  const message = error ? (CONNECT_ERRORS.get(error) ?? CONNECT_FAILED) : undefined;
  return (
    <Alert variant={error ? 'destructive' : 'default'}>
      <TwitchLogoIcon />
      <AlertTitle>{error ? 'Couldn’t connect Twitch' : 'Twitch connected'}</AlertTitle>
      <AlertDescription>
        {message ?? 'The show goes out to it whenever its output is running.'}{' '}
        <button type="button" className="underline underline-offset-2" onClick={dismiss}>
          Dismiss
        </button>
      </AlertDescription>
    </Alert>
  );
};

interface ConnectTwitchButtonProps {
  organisationId: string;
  /** Whether this deployment has a Twitch application to connect with. */
  enabled: boolean;
}

const ConnectTwitchButton: FC<ConnectTwitchButtonProps> = ({ organisationId, enabled }) => {
  const connect = useConnectTwitch(organisationId);
  return (
    <div className="flex flex-col gap-1">
      <Button
        loading={connect.isPending}
        disabled={!enabled}
        title={enabled ? undefined : 'This studio has no Twitch application configured.'}
        onClick={() => connect.mutate()}
      >
        <TwitchLogoIcon />
        Connect Twitch
      </Button>
      <FormError error={connect.error} />
    </div>
  );
};

interface AddRtmpDialogProps {
  organisationId: string;
}

/** Add any RTMP(S) destination by hand: YouTube, a second Twitch account, a restreaming service. */
const AddRtmpDialog: FC<AddRtmpDialogProps> = ({ organisationId }) => {
  const [open, setOpen] = useState(false);
  const create = useCreateRtmpChannel(organisationId);
  const defaultValues: RtmpChannelInput = { name: '', url: '', key: '' };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: RtmpChannelSchema },
    onSubmit: ({ value, formApi }) =>
      create.mutate(RtmpChannelSchema.parse(value), {
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
      <DialogTrigger render={<Button variant="outline" />}>
        <PlusIcon />
        Add RTMP destination
      </DialogTrigger>
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

interface ChannelRowProps {
  organisationId: string;
  channel: Channel;
}

/** A channel: what it is, whether the broadcast goes out to it, and removing it. */
const ChannelRow: FC<ChannelRowProps> = ({ organisationId, channel }) => {
  const setEnabled = useSetChannelEnabled(organisationId);
  const remove = useDeleteChannel(organisationId);
  const enabled = setEnabled.isPending ? setEnabled.variables.enabled : channel.enabled;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">{channel.kind === 'twitch' ? <TwitchLogoIcon /> : <BroadcastIcon />}</ItemMedia>
      <ItemContent>
        <ItemTitle>
          {channel.name}
          {enabled ? null : <Badge variant="outline">Off</Badge>}
        </ItemTitle>
        <ItemDescription>
          {channel.kind === 'twitch' && channel.externalLogin
            ? `twitch.tv/${channel.externalLogin}`
            : 'RTMP destination'}
        </ItemDescription>
        <FormError error={setEnabled.error ?? remove.error} />
      </ItemContent>
      <ItemActions>
        <Switch
          aria-label={enabled ? `Stop sending to ${channel.name}` : `Send to ${channel.name}`}
          checked={enabled}
          disabled={setEnabled.isPending || remove.isPending}
          onCheckedChange={next => setEnabled.mutate({ channelId: channel.id, enabled: next })}
        />
        <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(channel.id)}>
          Remove
        </Button>
      </ItemActions>
    </Item>
  );
};
