import type { FC, ReactNode } from 'react';
import { ArrowSquareInIcon, FolderSimpleIcon, NetworkIcon, NetworkXIcon } from '@phosphor-icons/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { useSignalFocus, useSignalTopology } from '@/components/signal/signal-context';
import {
  SignalGroup,
  SignalGroupCaret,
  SignalGroupContent,
  SignalGroupMember,
  SignalGroupMembers,
  SignalGroupShut,
  SignalGroupShutContent,
  SignalGroupTrigger
} from '@/components/signal/signal-group';
import { PlatformIcon, SourceIcon } from '@/components/signal/signal-icons';
import {
  SignalAspect,
  SignalBars,
  SignalDots,
  SignalHealth,
  SignalNodeFlag,
  SignalNodeIcon
} from '@/components/signal/signal-node';
import { Reveal } from '@/components/signal/signal-presence';
import {
  SignalList,
  SignalListIcon,
  SignalListItem,
  SignalListNote,
  SignalListText,
  SignalListTrail,
  SignalStack,
  SignalTier,
  SignalTierHeader,
  SignalTierTitle
} from '@/components/signal/signal-stack';
import type { SignalBroadcast, SignalChannel } from '@/components/signal/signal-system';
import { useSignalThing } from '@/components/signal/signal-things';
import {
  broadcastTrouble,
  channelTrouble,
  sourceTrouble,
  type GroupView,
  type SourceView,
  type SubgroupView
} from '@/components/signal/signal-topology';

// The signal as a quiet stack, for a screen too narrow for the map: a tier each for channels, broadcasts and
// sources, a row a thing. Its tiers are parts a page composes inside <SignalStackLayout>, each with the end of its
// header holding whatever the page puts there (a way to add to it, say); <SignalStackView> is them composed with nothing
// more. What its things do is the page's (useSignalThing).

/** How far in a group's members sit, and a subgroup's further. */
const MEMBER = 'min-h-9 border-t border-border/60 py-1.5 text-custom-12';

interface ChannelProps {
  channel: SignalChannel;
}

/** A channel's row: a second line only when something's wrong, and its bars (or, cut off, a dot) at the end. */
const StackChannel: FC<ChannelProps> = ({ channel }) => {
  const trouble = channelTrouble(channel);
  const thing = useSignalThing({ kind: 'channel', id: channel.id });
  return (
    <SignalListItem id={channel.id} {...thing}>
      <SignalNodeIcon>
        <PlatformIcon platform={channel.platform} />
      </SignalNodeIcon>
      <SignalListText>
        <span className="truncate">{channel.handle}</span>
        <Reveal when={trouble !== null}>
          <SignalListNote tone={trouble?.tone ?? 'warning'}>{trouble?.text}</SignalListNote>
        </Reveal>
      </SignalListText>
      <SignalListTrail>
        {channel.status === 'affected' ? (
          <SignalHealth status="affected" />
        ) : (
          <SignalBars level={channel.level} status={channel.status} />
        )}
      </SignalListTrail>
    </SignalListItem>
  );
};

interface BroadcastProps {
  broadcast: SignalBroadcast;
}

const StackBroadcast: FC<BroadcastProps> = ({ broadcast }) => {
  const { system, groups } = useSignalTopology();
  const focus = useSignalFocus();
  const trouble = broadcastTrouble(broadcast);
  const channels = system.channels.filter(channel => channel.broadcast === broadcast.id).length;
  const sources = groups.flatMap(group => group.sources).filter(source => source.feeds.includes(broadcast.id)).length;
  const thing = useSignalThing({ kind: 'broadcast', id: broadcast.id });
  return (
    <SignalListItem id={broadcast.id} {...thing}>
      <SignalAspect width={broadcast.width} height={broadcast.height} />
      <SignalListText>
        {broadcast.name}
        <Reveal when={trouble !== null}>
          <SignalListNote tone="destructive">{trouble}</SignalListNote>
        </Reveal>
        {/* Picked, it says what it's wired to, since there are no wires here to show it. */}
        <Reveal when={focus.picked === broadcast.id && trouble === null}>
          <SignalListNote>
            To {channels} channel{channels === 1 ? '' : 's'} · from {sources} sources
          </SignalListNote>
        </Reveal>
      </SignalListText>
      <SignalListTrail>
        {broadcast.recording && trouble === null && <SignalNodeFlag tone="recording">Rec</SignalNodeFlag>}
        <SignalHealth status={broadcast.status} />
      </SignalListTrail>
    </SignalListItem>
  );
};

interface SourceProps {
  source: SourceView;
  /** What it is, to whatever's composed onto it: a camera, or an ingest. */
  kind: 'camera' | 'ingest';
  /** How far in it sits: under its network, or further in under its subgroup. */
  className: string;
}

/** A camera or an ingest, as a row under its group's. */
const StackSource: FC<SourceProps> = ({ source, kind, className }) => {
  const thing = useSignalThing({ kind, id: source.id });
  return (
    <SignalListItem id={source.id} className={cn(MEMBER, className)} {...thing}>
      <SignalListIcon>
        <SourceIcon kind={source.kind} />
      </SignalListIcon>
      <SignalListText>
        {source.name}
        <Reveal when={sourceTrouble(source) !== null}>
          <SignalListNote tone="destructive">Not sending</SignalListNote>
        </Reveal>
      </SignalListText>
      <SignalListTrail>
        <SignalHealth status={source.seen} />
      </SignalListTrail>
    </SignalListItem>
  );
};

interface SubgroupProps {
  subgroup: SubgroupView;
}

const StackSubgroup: FC<SubgroupProps> = ({ subgroup }) => {
  return (
    <SignalGroup id={subgroup.id}>
      <SignalGroupTrigger render={<SignalListItem id={subgroup.id} className={cn(MEMBER, 'pl-10')} />}>
        <SignalListIcon>
          <FolderSimpleIcon />
        </SignalListIcon>
        <SignalListText>
          <span className="flex items-center gap-1.5 truncate">
            {subgroup.name}
            <SignalGroupCaret />
          </span>
          <Reveal when={subgroup.trouble !== null}>
            <SignalListNote tone="destructive">{subgroup.trouble}</SignalListNote>
          </Reveal>
        </SignalListText>
        <SignalListTrail>
          <SignalGroupShut>
            <SignalDots statuses={subgroup.sources.map(source => source.seen)} className="max-w-28 justify-end" />
          </SignalGroupShut>
        </SignalListTrail>
      </SignalGroupTrigger>
      <SignalGroupMembers>
        {subgroup.sources.map(source => (
          <SignalGroupMember key={source.id} kept={subgroup.stopped.some(each => each.id === source.id)}>
            <StackSource source={source} kind="camera" className="pl-[4.25rem]" />
          </SignalGroupMember>
        ))}
      </SignalGroupMembers>
    </SignalGroup>
  );
};

interface GroupProps {
  group: GroupView;
}

const StackNetwork: FC<GroupProps> = ({ group }) => {
  return (
    <SignalGroup id={group.id}>
      <SignalGroupTrigger render={<SignalListItem id={group.id} />}>
        <SignalNodeIcon className={cn('transition-colors duration-300', group.down && 'text-destructive')}>
          {group.down ? <NetworkXIcon /> : <NetworkIcon />}
        </SignalNodeIcon>
        <SignalListText>
          <span className="flex items-center gap-1.5 truncate">
            {group.name}
            <SignalGroupCaret />
          </span>
          <Reveal when={group.trouble !== null}>
            <SignalListNote tone="destructive">{group.trouble}</SignalListNote>
          </Reveal>
        </SignalListText>
        <SignalListTrail>
          <SignalGroupShut>
            <SignalDots statuses={group.sources.map(source => source.seen)} className="max-w-28 justify-end" />
          </SignalGroupShut>
        </SignalListTrail>
      </SignalGroupTrigger>
      {/* Shut, whatever has stopped is listed anyway, straight under the network, whichever subgroup it's in: those in
          one, here, until they open into it; the network's own stay where they are (they're kept members). */}
      <SignalGroupShutContent>
        {group.subgroups
          .flatMap(subgroup => subgroup.stopped)
          .map(source => (
            <StackSource key={source.id} source={source} kind="camera" className="pl-10" />
          ))}
      </SignalGroupShutContent>
      <SignalGroupContent>
        {group.subgroups.map(subgroup => (
          <StackSubgroup key={subgroup.id} subgroup={subgroup} />
        ))}
      </SignalGroupContent>
      <SignalGroupMembers>
        {group.ungrouped.map(source => (
          <SignalGroupMember key={source.id} kept={group.stopped.some(each => each.id === source.id)}>
            <StackSource source={source} kind="camera" className="pl-10" />
          </SignalGroupMember>
        ))}
      </SignalGroupMembers>
    </SignalGroup>
  );
};

/** The ingests: no network's, so nothing to open or shut; always listed one by one. */
const StackIngests: FC<GroupProps> = ({ group }) => {
  return (
    <SignalGroup id={group.id} open>
      <SignalListItem id={group.id}>
        <SignalNodeIcon className="transition-colors duration-300">
          <ArrowSquareInIcon />
        </SignalNodeIcon>
        <SignalListText>
          <span className="flex items-center gap-1.5 truncate">{group.name}</span>
        </SignalListText>
        <SignalListTrail />
      </SignalListItem>
      <SignalGroupContent>
        {group.ungrouped.map(source => (
          <StackSource key={source.id} source={source} kind="ingest" className="pl-10" />
        ))}
      </SignalGroupContent>
    </SignalGroup>
  );
};

export interface SignalStackLayoutProps {
  /** Its tiers, in order: channels, broadcasts, sources. */
  children: ReactNode;
}

/** The stack around its tiers. */
export const SignalStackLayout: FC<SignalStackLayoutProps> = ({ children }) => {
  return <SignalStack className="gap-6">{children}</SignalStack>;
};

export interface SignalStackTierProps {
  /** What goes at the end of the tier's header. */
  children?: ReactNode;
}

export const SignalStackChannels: FC<SignalStackTierProps> = ({ children }) => {
  const { system } = useSignalTopology();
  return (
    <SignalTier>
      <SignalTierHeader className="px-1">
        <SignalTierTitle>Channels</SignalTierTitle>
        <div className="ml-auto flex items-center">{children}</div>
      </SignalTierHeader>
      <SignalList>
        {system.channels.map(channel => (
          <StackChannel key={channel.id} channel={channel} />
        ))}
      </SignalList>
    </SignalTier>
  );
};

export const SignalStackBroadcasts: FC<SignalStackTierProps> = ({ children }) => {
  const { system } = useSignalTopology();
  return (
    <SignalTier>
      <SignalTierHeader className="px-1">
        <SignalTierTitle>Broadcasts</SignalTierTitle>
        <div className="ml-auto flex items-center">{children}</div>
      </SignalTierHeader>
      <SignalList>
        {system.broadcasts.map(broadcast => (
          <StackBroadcast key={broadcast.id} broadcast={broadcast} />
        ))}
      </SignalList>
    </SignalTier>
  );
};

/** The sources, by network, then the ingests. */
export const SignalStackSources: FC<SignalStackTierProps> = ({ children }) => {
  const { groups } = useSignalTopology();
  return (
    <SignalTier>
      <SignalTierHeader className="px-1">
        <SignalTierTitle>Sources</SignalTierTitle>
        <div className="ml-auto flex items-center">{children}</div>
      </SignalTierHeader>
      <SignalList>
        {groups.map(group =>
          group.network === null ? (
            <StackIngests key={group.id} group={group} />
          ) : (
            <StackNetwork key={group.id} group={group} />
          )
        )}
      </SignalList>
    </SignalTier>
  );
};

/** The stack with nothing more: its tiers as they are. */
export const SignalStackView: FC = () => {
  return (
    <SignalStackLayout>
      <SignalStackChannels />
      <SignalStackBroadcasts />
      <SignalStackSources />
    </SignalStackLayout>
  );
};
