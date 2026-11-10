import { Suspense, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link, Outlet, useSearchParams } from 'react-router';
import { BroadcastIcon, PlusIcon, TwitchLogoIcon } from '@phosphor-icons/react';
import type { Channel, Show } from '@conservationtv/studio-sdk';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
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

import type { Route } from './+types/channels';
import { ChannelPlatformState } from '@/components/channels/platform-state';
import { FormError } from '@/components/common/form-error';
import { channelListQueryOptions, useConnectTwitch, useDeleteChannel } from '@/queries/channels';
import { showListQueryOptions } from '@/queries/shows';

export const meta: Route.MetaFunction = () => [{ title: 'Channels · conservation.tv studio' }];

/** What the API's Twitch callback says happened, by its `?error=`. */
const CONNECT_ERRORS = new Map([
  ['expired', 'The connection took too long, or was started by someone else. Try again.'],
  ['refused', 'Twitch didn’t give the studio access. Try again, and approve it on Twitch.']
]);
/** Any other failure: Twitch, or keeping what it gave, failed. */
const CONNECT_FAILED = 'Twitch couldn’t be reached, or didn’t answer as expected. Try again in a moment.';

/**
 * Where the organisation's shows go out to: Twitch channels, connected on Twitch, and any RTMP(S) destination by its
 * server URL and stream key. A show's output agent forwards its program to each channel the show forwards to. Stream
 * keys are never shown again once saved: only output agents read them.
 */
const ChannelsRoute: FC<Route.ComponentProps> = ({ params }) => {
  const { organisationId } = params;
  const [channelsQuery, showsQuery] = useSuspenseQueries({
    queries: [channelListQueryOptions(organisationId), showListQueryOptions(organisationId)]
  });
  const { channels } = channelsQuery.data;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-10 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-custom-21 font-semibold text-foreground">Channels</h1>
        <p className="max-w-2xl text-custom-13 leading-(--leading-custom-body) text-custom-text-secondary">
          Where shows go out to. A show’s output sends the broadcast to each channel the show forwards to, and keeps
          them live with a holding picture while OBS restarts.
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
            <ChannelRow
              key={channel.id}
              organisationId={organisationId}
              channel={channel}
              shows={showsQuery.data.filter(show => show.forwards.some(forward => forward.channelId === channel.id))}
            />
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
  /** The shows forwarded to it, on or off. */
  shows: Show[];
}

/** A channel: what it is, what its platform last said of it, the shows that go out on it, and removing it. */
const ChannelRow: FC<ChannelRowProps> = ({ organisationId, channel, shows }) => {
  const remove = useDeleteChannel(organisationId);
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">{channel.kind === 'twitch' ? <TwitchLogoIcon /> : <BroadcastIcon />}</ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap">
          {channel.name}
          <Suspense fallback={null}>
            <ChannelPlatformState channelId={channel.id} />
          </Suspense>
        </ItemTitle>
        <ItemDescription>
          {channel.kind === 'twitch' && channel.externalLogin
            ? `twitch.tv/${channel.externalLogin}`
            : 'RTMP destination'}
        </ItemDescription>
        <ChannelShows channelId={channel.id} shows={shows} />
        <FormError error={remove.error} />
      </ItemContent>
      <ItemActions>
        <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(channel.id)}>
          Remove
        </Button>
      </ItemActions>
    </Item>
  );
};

interface ChannelShowsProps {
  channelId: string;
  /** The shows forwarded to the channel. */
  shows: Show[];
}

/** Which shows go out on the channel, each opening its page, and which of them have it switched off. */
const ChannelShows: FC<ChannelShowsProps> = ({ channelId, shows }) => {
  if (shows.length === 0) {
    return <ItemDescription>No show goes out on it. Add it to a show from the show’s page.</ItemDescription>;
  }
  return (
    <ItemDescription>
      On{' '}
      {shows.map((show, index) => {
        const enabled = show.forwards.some(forward => forward.channelId === channelId && forward.enabled);
        return (
          <span key={show.id}>
            {index > 0 && ', '}
            <Link to={`../shows/${show.id}`} relative="path" className="text-foreground underline underline-offset-2">
              {show.name}
            </Link>
            {!enabled && ' (off)'}
          </span>
        );
      })}
    </ItemDescription>
  );
};
