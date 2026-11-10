import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, useSearchParams } from 'react-router';
import { BroadcastIcon, PlusIcon, TwitchLogoIcon } from '@phosphor-icons/react';
import type { Channel } from '@conservationtv/studio-sdk';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
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
import { channelListQueryOptions, useConnectTwitch, useDeleteChannel, useSetChannelEnabled } from '@/queries/channels';

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
  const { channels } = list.data;
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
        <ConnectTwitchButton organisationId={organisationId} />
        <Button variant="outline" nativeButton={false} render={<Link to="rtmp/new" />}>
          <PlusIcon />
          Add RTMP destination
        </Button>
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
      {/* A dialog routed over the page: adding an RTMP destination at `rtmp/new`. */}
      <Outlet />
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
}

const ConnectTwitchButton: FC<ConnectTwitchButtonProps> = ({ organisationId }) => {
  const connect = useConnectTwitch(organisationId);
  return (
    <div className="flex flex-col gap-1">
      <Button loading={connect.isPending} onClick={() => connect.mutate()}>
        <TwitchLogoIcon />
        Connect Twitch
      </Button>
      <FormError error={connect.error} />
    </div>
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
