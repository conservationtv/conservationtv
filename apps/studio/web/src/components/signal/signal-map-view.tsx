import type { FC, ReactNode } from 'react';
import { ArrowSquareInIcon, EyeIcon, FolderSimpleIcon, NetworkIcon, NetworkXIcon } from '@phosphor-icons/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { SignalAdd, SignalEditAction } from '@/components/signal/editing/signal-editing';
import type { SignalTarget } from '@/components/signal/editing/signal-editing-store';
import { useSignalGroup, useSignalTopology } from '@/components/signal/signal-context';
import {
  SignalGroup,
  SignalGroupCaret,
  SignalGroupContent,
  SignalGroupMember,
  SignalGroupMembers,
  SignalGroupNote,
  SignalGroupShut,
  SignalGroupShutContent,
  SignalGroupTrigger
} from '@/components/signal/signal-group';
import { GatewayIcon, PlatformIcon, SourceIcon } from '@/components/signal/signal-icons';
import { SignalLinks } from '@/components/signal/signal-links';
import {
  SignalColumn,
  SignalColumnContent,
  SignalColumnCount,
  SignalColumnHeader,
  SignalColumnItem,
  SignalJoin,
  SignalLane,
  SignalLaneHeader,
  SignalMap,
  SignalRail,
  SignalRailHead,
  SignalRails
} from '@/components/signal/signal-map';
import {
  SignalAspect,
  SignalBars,
  SignalDots,
  SignalHealth,
  SignalNode,
  SignalNodeBody,
  SignalNodeFlag,
  SignalNodeIcon,
  SignalNodeMeta,
  SignalNodeTitle
} from '@/components/signal/signal-node';
import { Appear, Reveal, Swap } from '@/components/signal/signal-presence';
import type { SignalBroadcast, SignalChannel, SignalNetwork } from '@/components/signal/signal-system';
import { useSignalThing } from '@/components/signal/signal-things';
import {
  broadcastTroubled,
  broadcastTrouble,
  channelTroubled,
  channelTrouble,
  groupTroubled,
  joinId,
  sourceTrouble,
  type GroupView,
  type SourceView,
  type SubgroupView
} from '@/components/signal/signal-topology';

// The signal as a map, for a screen wide enough: channels, broadcasts and sources in three columns, the gateways as
// rails between the last two, and the links drawn behind. A composition of the signal's parts, with editing's set
// among them (they do nothing unless the page is editable). What its things do is the page's (useSignalThing).

/**
 * The three columns share the map's width equally, between a floor (below it the map scrolls sideways) and a ceiling
 * (past it the map stops growing and keeps to the left); the gaps and rails between them stay as they are.
 */
const COLUMN = 'min-w-46 max-w-96 flex-1 basis-0';

interface ChannelProps {
  channel: SignalChannel;
}

/** The line under a channel's handle: what's wrong with it, or how many are watching. */
const ChannelNote: FC<ChannelProps> = ({ channel }) => {
  const trouble = channelTrouble(channel);
  if (trouble === null && channel.viewers === undefined) return null;
  return (
    <Swap id={trouble ? channel.status : 'watching'}>
      {trouble ? (
        <SignalNodeMeta tone={trouble.tone}>{trouble.text}</SignalNodeMeta>
      ) : (
        <SignalNodeMeta>
          <EyeIcon />
          {channel.viewers?.toLocaleString('en-GB')} watching
        </SignalNodeMeta>
      )}
    </Swap>
  );
};

const MapChannel: FC<ChannelProps> = ({ channel }) => {
  const thing = useSignalThing({ kind: 'channel', id: channel.id });
  return (
    <SignalNode
      id={channel.id}
      status={channel.status}
      off={channel.off}
      className="-mx-2 w-[calc(100%+1rem)] rounded-md px-2 hover:bg-muted/60"
      {...thing}
    >
      <SignalNodeIcon>
        <PlatformIcon platform={channel.platform} />
      </SignalNodeIcon>
      <SignalNodeBody>
        <SignalNodeTitle>{channel.handle}</SignalNodeTitle>
        <ChannelNote channel={channel} />
      </SignalNodeBody>
      <Appear when={!channel.off && channel.status !== 'affected'}>
        <SignalBars level={channel.level} status={channel.status} />
      </Appear>
    </SignalNode>
  );
};

interface BroadcastProps {
  broadcast: SignalBroadcast;
}

const MapBroadcast: FC<BroadcastProps> = ({ broadcast }) => {
  const trouble = broadcastTrouble(broadcast);
  const target: SignalTarget = { kind: 'broadcast', id: broadcast.id };
  const thing = useSignalThing(target);
  return (
    <SignalNode id={broadcast.id} status={broadcast.status} variant="card" className="items-start" {...thing}>
      <SignalAspect width={broadcast.width} height={broadcast.height} />
      <SignalNodeBody>
        <SignalNodeTitle className="font-medium">{broadcast.name}</SignalNodeTitle>
        <Swap id={trouble ? 'failing' : 'format'}>
          {trouble ? (
            <SignalNodeMeta tone="destructive">{trouble}</SignalNodeMeta>
          ) : (
            <SignalNodeMeta>
              {broadcast.width}×{broadcast.height}
            </SignalNodeMeta>
          )}
        </Swap>
        <Reveal when={broadcast.recording && !trouble}>
          <SignalNodeFlag tone="recording">Recording</SignalNodeFlag>
        </Reveal>
      </SignalNodeBody>
      <SignalEditAction target={target} className="-my-1 -mr-1.5" />
    </SignalNode>
  );
};

interface SourceProps {
  source: SourceView;
  /** What it is, to whatever's composed onto it: a camera, or an ingest. */
  kind: 'camera' | 'ingest';
}

/** A camera or an ingest, as a pill under its group's label. */
const MapSource: FC<SourceProps> = ({ source, kind }) => {
  const thing = useSignalThing({ kind, id: source.id });
  return (
    <SignalNode id={source.id} status={source.seen} variant="pill" className="hover:bg-muted/60" {...thing}>
      <SignalNodeIcon>
        <SourceIcon kind={source.kind} />
      </SignalNodeIcon>
      <SignalNodeTitle className="flex-1">{source.name}</SignalNodeTitle>
      <Appear when={sourceTrouble(source) !== null}>
        <SignalNodeFlag tone="destructive">Not sending</SignalNodeFlag>
      </Appear>
      <SignalHealth status={source.seen} />
    </SignalNode>
  );
};

interface GroupJoinProps {
  /** Something of the group's is on show while it's shut: what has stopped. */
  shown: boolean;
}

/** Where a group's members on show meet the rail: one point, at its label. */
const GroupJoin: FC<GroupJoinProps> = ({ shown }) => {
  const group = useSignalGroup();
  if (!group.open && !shown) return null;
  return <SignalJoin id={joinId(group.id)} lifted className="top-2.5 left-0" />;
};

interface GroupActionProps {
  target: SignalTarget;
}

/** A label's "more", at its end: the dots hold the end while the group is shut, so open it has to take it itself. */
const GroupAction: FC<GroupActionProps> = ({ target }) => {
  const group = useSignalGroup();
  return <SignalEditAction target={target} className={cn('-my-1 -mr-1.5', group.open && 'ml-auto')} />;
};

interface SubgroupProps {
  subgroup: SubgroupView;
}

/**
 * A subgroup: a label among its network's cameras, shut to a line as its network is; its wire, and its cameras' when
 * open, run to the network's point on the rail like any camera's.
 */
const MapSubgroup: FC<SubgroupProps> = ({ subgroup }) => {
  return (
    <SignalGroup id={subgroup.id}>
      <SignalGroupTrigger
        render={
          <SignalNode id={subgroup.id} status={subgroup.status} className="h-7 gap-1.5 rounded-md text-custom-12" />
        }
      >
        <SignalNodeIcon>
          <FolderSimpleIcon />
        </SignalNodeIcon>
        <span className="truncate">{subgroup.name}</span>
        <SignalGroupCaret />
        <Appear when={subgroup.trouble !== null}>
          <span className="text-custom-11 text-destructive">{subgroup.trouble}</span>
        </Appear>
        <SignalGroupShut className="ml-auto">
          <SignalDots statuses={subgroup.sources.map(source => source.seen)} className="flex-nowrap" />
        </SignalGroupShut>
        <GroupAction target={{ kind: 'subgroup', id: subgroup.id }} />
      </SignalGroupTrigger>
      <SignalGroupMembers variant="raised" className="pl-6">
        {subgroup.sources.map(source => (
          <SignalGroupMember key={source.id} kept={subgroup.stopped.some(each => each.id === source.id)}>
            <MapSource source={source} kind="camera" />
          </SignalGroupMember>
        ))}
      </SignalGroupMembers>
    </SignalGroup>
  );
};

interface NetworkProps {
  group: GroupView;
  network: SignalNetwork;
}

/** A network: one label, open or shut, so its caret can turn; its own wire runs from the label either way. */
const MapNetwork: FC<NetworkProps> = ({ group, network }) => {
  return (
    // Positioned, so its join sits at its label rather than at the top of the map.
    <SignalGroup id={group.id} className="relative gap-0">
      <GroupJoin shown={group.stopped.length > 0} />
      <SignalGroupTrigger
        render={<SignalNode id={group.id} status={group.status} className="h-5 gap-1.5 rounded-sm text-custom-12" />}
      >
        <SignalNodeIcon className={cn('transition-colors duration-300', group.down && 'text-destructive')}>
          {group.down ? <NetworkXIcon /> : <NetworkIcon />}
        </SignalNodeIcon>
        <span className="font-medium">{group.name}</span>
        <SignalGroupCaret />
        <SignalGroupShut className="ml-auto">
          <SignalDots statuses={group.sources.map(source => source.seen)} className="flex-nowrap" />
        </SignalGroupShut>
        <GroupAction target={{ kind: 'network', id: group.id }} />
      </SignalGroupTrigger>
      <SignalGroupNote tone={group.trouble ? 'destructive' : 'default'}>
        {group.trouble ?? network.agent}
      </SignalGroupNote>
      {/* Shut, whatever has stopped is on show anyway, straight under the label, whichever subgroup it's in: those in
          one, here, until they open into it; the network's own stay where they are (they're kept members). */}
      <SignalGroupShutContent variant="raised">
        {group.subgroups
          .flatMap(subgroup => subgroup.stopped)
          .map(source => (
            <MapSource key={source.id} source={source} kind="camera" />
          ))}
      </SignalGroupShutContent>
      {group.subgroups.length > 0 && (
        <SignalGroupContent variant="raised">
          {group.subgroups.map(subgroup => (
            <MapSubgroup key={subgroup.id} subgroup={subgroup} />
          ))}
        </SignalGroupContent>
      )}
      <SignalGroupMembers variant="raised">
        {group.ungrouped.map(source => (
          <SignalGroupMember key={source.id} kept={group.stopped.some(each => each.id === source.id)}>
            <MapSource source={source} kind="camera" />
          </SignalGroupMember>
        ))}
      </SignalGroupMembers>
    </SignalGroup>
  );
};

interface GroupProps {
  group: GroupView;
}

/** The ingests: no network's, so nothing to open or shut; always listed one by one. */
const MapIngests: FC<GroupProps> = ({ group }) => {
  return (
    <SignalGroup id={group.id} open className="relative gap-0">
      <SignalNode id={group.id} status={group.status} className="h-5 gap-1.5 rounded-sm text-custom-12">
        <SignalNodeIcon className="transition-colors duration-300">
          <ArrowSquareInIcon />
        </SignalNodeIcon>
        <span className="font-medium">{group.name}</span>
      </SignalNode>
      <SignalGroupNote>pushed from anywhere</SignalGroupNote>
      <SignalGroupContent variant="raised">
        {group.ungrouped.map(source => (
          <MapSource key={source.id} source={source} kind="ingest" />
        ))}
      </SignalGroupContent>
    </SignalGroup>
  );
};

const MapGroup: FC<GroupProps> = ({ group }) => {
  if (group.network === null) return <MapIngests group={group} />;
  return <MapNetwork group={group} network={group.network} />;
};

interface AttentionProps {
  /** How many are in it: none, and there's no lane. */
  count: number;
  children: ReactNode;
}

/** A column's lane for what needs looking at, there while anything does. */
const Attention: FC<AttentionProps> = ({ count, children }) => {
  if (count === 0) return null;
  return (
    <SignalLane>
      <SignalLaneHeader>
        Needs attention
        <SignalColumnCount className="text-destructive/70">{count}</SignalColumnCount>
      </SignalLaneHeader>
      {children}
    </SignalLane>
  );
};

export const SignalMapView: FC = () => {
  const { system, groups } = useSignalTopology();
  // Each column's troubled things go up into its lane, in their own order; the rest keep theirs below it.
  const troubledChannels = system.channels.filter(channelTroubled);
  const steadyChannels = system.channels.filter(channel => !channelTroubled(channel));
  const troubledBroadcasts = system.broadcasts.filter(broadcastTroubled);
  const steadyBroadcasts = system.broadcasts.filter(broadcast => !broadcastTroubled(broadcast));
  const troubledGroups = groups.filter(groupTroubled);
  const steadyGroups = groups.filter(group => !groupTroubled(group));
  return (
    <SignalMap className="min-w-0 px-2 pt-1 pb-6">
      <SignalColumn className={COLUMN}>
        <SignalColumnHeader>
          Channels
          <SignalColumnCount>{system.channels.length}</SignalColumnCount>
        </SignalColumnHeader>
        <SignalColumnContent>
          <Attention count={troubledChannels.length}>
            {troubledChannels.map(channel => (
              <SignalColumnItem key={channel.id} id={channel.id}>
                <MapChannel channel={channel} />
              </SignalColumnItem>
            ))}
          </Attention>
          {steadyChannels.map(channel => (
            <SignalColumnItem key={channel.id} id={channel.id}>
              <MapChannel channel={channel} />
            </SignalColumnItem>
          ))}
          <SignalAdd target={{ kind: 'add-channel' }}>Add channel</SignalAdd>
        </SignalColumnContent>
      </SignalColumn>
      <SignalColumn className={COLUMN}>
        <SignalColumnHeader>
          Broadcasts
          <SignalColumnCount>{system.broadcasts.length}</SignalColumnCount>
        </SignalColumnHeader>
        <SignalColumnContent gap={4} order={3}>
          <Attention count={troubledBroadcasts.length}>
            {troubledBroadcasts.map(broadcast => (
              <SignalColumnItem key={broadcast.id} id={broadcast.id}>
                <MapBroadcast broadcast={broadcast} />
              </SignalColumnItem>
            ))}
          </Attention>
          {steadyBroadcasts.map(broadcast => (
            <SignalColumnItem key={broadcast.id} id={broadcast.id}>
              <MapBroadcast broadcast={broadcast} />
            </SignalColumnItem>
          ))}
          <SignalAdd target={{ kind: 'add-broadcast' }}>Add broadcast</SignalAdd>
        </SignalColumnContent>
      </SignalColumn>
      <SignalRails>
        {system.gateways.map((gateway, index) => (
          // The first is always there, and only fades up with the page; any other makes room for itself.
          <SignalRail key={gateway.id} id={gateway.id} gather="left" permanent={index === 0}>
            <SignalRailHead label={gateway.name}>
              <GatewayIcon gateway={gateway} />
            </SignalRailHead>
          </SignalRail>
        ))}
      </SignalRails>
      <SignalColumn className={COLUMN}>
        <SignalColumnHeader>
          Sources
          <SignalColumnCount>{system.cameras.length + system.ingests.length}</SignalColumnCount>
        </SignalColumnHeader>
        <SignalColumnContent gap={5} order={5}>
          <Attention count={troubledGroups.length}>
            {troubledGroups.map(group => (
              <SignalColumnItem key={group.id} id={group.id}>
                <MapGroup group={group} />
              </SignalColumnItem>
            ))}
          </Attention>
          {steadyGroups.map(group => (
            <SignalColumnItem key={group.id} id={group.id}>
              <MapGroup group={group} />
            </SignalColumnItem>
          ))}
          <SignalAdd target={{ kind: 'add-source' }}>Add source</SignalAdd>
        </SignalColumnContent>
      </SignalColumn>
      <SignalLinks />
    </SignalMap>
  );
};
