import { useRef, useState, useSyncExternalStore, type FC, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { AnimatePresence, motion, MotionConfig, type Transition, type Variants } from 'motion/react';
import {
  ArrowRightIcon,
  ArrowSquareInIcon,
  CaretDownIcon,
  CaretRightIcon,
  CloudIcon,
  DotsThreeIcon,
  EyeIcon,
  FolderSimpleIcon,
  HardDrivesIcon,
  NetworkIcon,
  NetworkXIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  VideoCameraIcon
} from '@phosphor-icons/react';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@conservationtv/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@conservationtv/ui/components/dropdown-menu';
import { Field, FieldGroup, FieldLabel } from '@conservationtv/ui/components/field';
import { Input } from '@conservationtv/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@conservationtv/ui/components/sheet';
import { Switch } from '@conservationtv/ui/components/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import { AnimateHeight } from '@/components/common/animate-height';
import {
  AddPlaceholder,
  BroadcastFields,
  CameraEditFields,
  CameraFields,
  ChannelFields,
  Connecting,
  IngestKeys,
  InstallCommand,
  MoreButton,
  NetworkFields,
  ReplaceDevice
} from '@/components/overview/signal-edit';
import {
  pathThrough,
  SignalAspect,
  SignalBars,
  SignalColumn,
  SignalColumnContent,
  SignalColumnHeader,
  SignalDots,
  SignalGroup,
  SignalHealthDot,
  SignalJoin,
  SignalLinks,
  SignalMap,
  SignalNode,
  SignalNodeBody,
  SignalNodeFlag,
  SignalNodeIcon,
  SignalNodeMeta,
  SignalNodeTitle,
  SignalRail,
  type SignalLink,
  type SignalStatus
} from '@/components/overview/signal-map';
import {
  BROADCASTS,
  CHANNELS,
  INGESTS,
  NETWORK_SOURCES,
  NETWORKS,
  platformIcons,
  sourceIcons,
  type SampleBroadcast,
  type SampleChannel,
  type SampleNetwork,
  type SampleSource
} from '@/components/overview/signal-samples';
import {
  SignalList,
  SignalListItem,
  SignalListNote,
  SignalListText,
  SignalListTrail,
  SignalStack,
  SignalTier,
  SignalTierHeader,
  SignalTierTitle
} from '@/components/overview/signal-stack';

// The signal view as one working page, on made-up data, with its motion.
// Things come up into place and the links wipe in the way the signal runs; networks open and shut on a spring, their
// wires keeping to them; a change of state swaps words and pops the dots it touches; forms slide from one to the next.
// Small movements, all of them, and none for anyone who has asked for less motion. Nothing saves.

// ---------------------------------------------------------------------------------------------------------------------
// The system, and the states it can be in.

interface System {
  channels: SampleChannel[];
  broadcasts: SampleBroadcast[];
  networks: SampleNetwork[];
  /** Cameras, each on a network. */
  cameras: SampleSource[];
  /** Groups of cameras within a network, only to keep a long list in order. */
  subgroups: Subgroup[];
  /** Pushed from anywhere; never grouped. */
  ingests: SampleSource[];
  /** The gateway a network is reached through, when it isn't the cloud one. */
  gateways: Record<string, string>;
}

/** A named handful of a network's cameras: organisation only, nothing to do with how they're wired. */
interface Subgroup {
  id: string;
  name: string;
  network: string;
  cameras: string[];
}

const SUBGROUPS: Subgroup[] = [
  { id: 'sub-indoor', name: 'Indoor enclosures', network: 'main', cameras: ['marmoset', 'parrots', 'extra-3'] },
  { id: 'sub-small', name: 'Small animals', network: 'main', cameras: ['extra-2', 'extra-5', 'extra-7'] },
  { id: 'sub-predators', name: 'Predators', network: 'outdoor', cameras: ['fox', 'extra-1'] }
];

const HEALTHY: System = {
  channels: CHANNELS.map(channel => ({ ...channel, status: 'ok', level: 3 })),
  broadcasts: BROADCASTS,
  networks: NETWORKS,
  cameras: NETWORK_SOURCES.map(camera => ({ ...camera, status: 'ok' })),
  subgroups: SUBGROUPS,
  ingests: INGESTS,
  gateways: {}
};

const withCamera = (system: System, id: string, status: SignalStatus): System => ({
  ...system,
  cameras: system.cameras.map(camera => (camera.id === id ? { ...camera, status } : camera))
});

interface Scenario {
  key: string;
  label: string;
  note: string;
  system: System;
}

const SCENARIOS: Scenario[] = [
  { key: 'healthy', label: 'All healthy', note: 'Every camera sending, every channel live.', system: HEALTHY },
  {
    key: 'camera-down',
    label: 'A camera down',
    note: 'Nuthouse, in the main building, has stopped sending.',
    system: withCamera(HEALTHY, 'extra-3', 'failing')
  },
  {
    key: 'agent-down',
    label: 'A network’s agent down',
    note: 'pi-05 isn’t answering: nothing in the barn can be seen.',
    system: {
      ...HEALTHY,
      networks: HEALTHY.networks.map(network => (network.id === 'barn' ? { ...network, status: 'failing' } : network))
    }
  },
  {
    key: 'channel-struggling',
    label: 'A channel struggling',
    note: 'Twitch is dropping frames on /alveussanctuary.',
    system: {
      ...HEALTHY,
      channels: HEALTHY.channels.map(channel =>
        channel.id === 'twitch-sanctuary' ? { ...channel, status: 'degraded', level: 1 } : channel
      )
    }
  },
  {
    key: 'broadcast-down',
    label: 'A broadcast down',
    note: 'The social broadcast’s renderer has stopped; TikTok gets nothing.',
    system: {
      ...HEALTHY,
      broadcasts: HEALTHY.broadcasts.map(broadcast =>
        broadcast.id === 'social' ? { ...broadcast, status: 'failing' } : broadcast
      ),
      channels: HEALTHY.channels.map(channel =>
        channel.id === 'tiktok' ? { ...channel, status: 'affected', level: 0, viewers: undefined } : channel
      )
    }
  },
  {
    key: 'onsite',
    label: 'Two gateways',
    note: 'The barn’s cameras go through an on-site gateway, a second rail.',
    system: { ...HEALTHY, gateways: { barn: 'onsite' } }
  },
  {
    key: 'bad-day',
    label: 'A bad day',
    note: 'A camera down, the barn’s agent down and Twitch struggling, all at once.',
    system: {
      ...withCamera(HEALTHY, 'extra-3', 'failing'),
      networks: HEALTHY.networks.map(network => (network.id === 'barn' ? { ...network, status: 'failing' } : network)),
      channels: HEALTHY.channels.map(channel =>
        channel.id === 'twitch-sanctuary' ? { ...channel, status: 'degraded', level: 1 } : channel
      )
    }
  }
];

const RAILS: Record<string, { icon: ReactNode; label: string }> = {
  gateway: { icon: <CloudIcon />, label: 'conservation.tv gateway' },
  onsite: { icon: <HardDrivesIcon />, label: 'On-site gateway (barn-gw)' }
};

// ---------------------------------------------------------------------------------------------------------------------
// What's wired to what: the same for the map and the stack.

interface Group {
  id: string;
  network?: SampleNetwork;
  /** Every member, grouped or not. */
  sources: SampleSource[];
  /** Its members that are in a subgroup, by subgroup; and the rest, listed after them. */
  subgroups: Sub[];
  ungrouped: SampleSource[];
}

interface Sub {
  id: string;
  name: string;
  sources: SampleSource[];
}

const INGESTS_ID = 'ingests';

function groupsOf(system: System): Group[] {
  return [
    ...system.networks.map(network => {
      const sources = system.cameras.filter(camera => camera.network === network.id);
      const subgroups = system.subgroups
        .filter(subgroup => subgroup.network === network.id)
        .map(subgroup => ({
          id: subgroup.id,
          name: subgroup.name,
          sources: sources.filter(source => subgroup.cameras.includes(source.id))
        }));
      const grouped = new Set(subgroups.flatMap(subgroup => subgroup.sources.map(source => source.id)));
      return { id: network.id, network, sources, subgroups, ungrouped: sources.filter(source => !grouped.has(source.id)) };
    }),
    { id: INGESTS_ID, sources: system.ingests, subgroups: [], ungrouped: system.ingests }
  ];
}

const isDown = (group: Group) => group.network?.status === 'failing';

/** A member's health as seen: unknown when its network's agent can't be reached. */
const seen = (group: Group, source: SampleSource): SignalStatus => (isDown(group) ? 'unknown' : source.status);

function groupStatus(group: Group): SignalStatus {
  if (isDown(group)) return 'failing';
  return group.sources.some(source => source.status === 'failing') ? 'degraded' : 'ok';
}

/** A subgroup's health at a glance: as its network's, but it has no agent of its own to be down. */
function subStatus(group: Group, sub: Sub): SignalStatus {
  if (isDown(group)) return 'unknown';
  return sub.sources.some(source => source.status === 'failing') ? 'degraded' : 'ok';
}

const broadcastOf = (channel: SampleChannel) => (channel.platform === 'tiktok' ? 'social' : 'full');

/** The ingests are always listed one by one; a network is, only when open. */
const shownOpen = (group: Group, open: string[]) => group.id === INGESTS_ID || open.includes(group.id);

interface Feed {
  id: string;
  group: string;
  social: boolean;
  status: SignalStatus;
}

/**
 * What feeds the broadcasts: a wire per network; in the open one, one more per subgroup and per camera on show (those
 * in no subgroup, and those in the subgroup that's open); and one per ingest. `open` holds the open network and the
 * open subgroup alike.
 */
function feedsOf(system: System, open: string[]): Feed[] {
  return groupsOf(system).flatMap((group): Feed[] => {
    const camera = (source: SampleSource): Feed => ({
      id: source.id,
      group: group.id,
      social: source.social === true,
      status: seen(group, source)
    });
    return [
      // A network's own wire, from its label to the rail, is there whether it's open or shut: first, so the point
      // where it meets the rail is its own, and its cameras' wires fan out from that.
      ...(group.id === INGESTS_ID
        ? []
        : [
            {
              id: group.id,
              group: group.id,
              social: group.sources.some(source => source.social),
              status: groupStatus(group)
            }
          ]),
      ...(shownOpen(group, open)
        ? [
            ...group.subgroups.flatMap(sub => [
              {
                id: sub.id,
                group: group.id,
                social: sub.sources.some(source => source.social),
                status: subStatus(group, sub)
              },
              ...(open.includes(sub.id) ? sub.sources : []).map(camera)
            ]),
            ...group.ungrouped.map(camera)
          ]
        : [])
    ];
  });
}

function linksOf(system: System, open: string[]): SignalLink[] {
  const feeds = feedsOf(system, open);
  const groupOf = new Map(feeds.map(feed => [feed.id, feed.group]));
  const railOf = (id: string) => system.gateways[groupOf.get(id) ?? id] ?? 'gateway';
  // An open network's cameras curve into its one point on the rail; anything else meets the rail on its own.
  const routeOf = (id: string): Pick<SignalLink, 'via' | 'curved'> => {
    const group = groupOf.get(id);
    return group !== undefined && group !== id && group !== INGESTS_ID
      ? { via: [`join-${group}`, railOf(id)] }
      : { via: railOf(id), curved: true };
  };
  const broadcastStatus = new Map(system.broadcasts.map(broadcast => [broadcast.id, broadcast.status]));
  return [
    ...system.channels.map(channel => ({
      from: broadcastOf(channel),
      to: channel.id,
      status: channel.status,
      off: channel.off
    })),
    ...feeds.flatMap(feed =>
      (feed.social ? ['full', 'social'] : ['full']).map(
        (to): SignalLink => ({
          from: feed.id,
          to,
          // Nothing reaches a broadcast that's down: its feeds are cut there.
          status: broadcastStatus.get(to) === 'failing' ? 'affected' : feed.status,
          ...routeOf(feed.id)
        })
      )
    )
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// What can be edited, and its form.

type Target =
  | { kind: 'channel'; id: string }
  | { kind: 'add-channel' }
  | { kind: 'broadcast'; id: string }
  | { kind: 'add-broadcast' }
  | { kind: 'network'; id: string }
  | { kind: 'subgroup'; id: string }
  | { kind: 'camera'; id: string }
  | { kind: 'ingest'; id: string }
  | { kind: 'add-source' }
  | { kind: 'add-camera'; network: string }
  | { kind: 'add-network' }
  | { kind: 'add-ingest' };

interface Form {
  title: ReactNode;
  description?: ReactNode;
  body: ReactNode;
  /** The main button; none for a chooser. */
  action?: string;
  /** In place of Cancel: what it's waiting for. */
  waiting?: ReactNode;
  removable?: boolean;
}

/** Big, plain choices: what kind of source to add. */
const Choice: FC<{ icon: ReactNode; title: string; description: string; onClick?: () => void; children?: ReactNode }> = ({
  icon,
  title,
  description,
  onClick,
  children
}) => (
  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
    <button
      type="button"
      onClick={onClick}
      disabled={onClick === undefined}
      className="flex items-start gap-2.5 text-left enabled:cursor-pointer [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
    >
      {icon}
      <span className="flex flex-col gap-0.5">
        <span className="text-custom-13 font-medium">{title}</span>
        <span className="text-custom-12 text-muted-foreground">{description}</span>
      </span>
    </button>
    {children}
  </div>
);

function formOf(target: Target, system: System, go: (next: Target) => void): Form {
  switch (target.kind) {
    case 'channel': {
      const channel = system.channels.find(each => each.id === target.id);
      return {
        title: channel?.handle ?? 'Channel',
        description: channel && `${channel.platform === 'twitch' ? 'Twitch' : channel.platform === 'youtube' ? 'YouTube' : 'TikTok'} channel`,
        action: 'Save',
        removable: true,
        body: (
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="channel-broadcast">Sends</FieldLabel>
              <NativeSelect id="channel-broadcast" defaultValue={channel && broadcastOf(channel)}>
                {system.broadcasts.map(broadcast => (
                  <NativeSelectOption key={broadcast.id} value={broadcast.id}>
                    {broadcast.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field orientation="horizontal" className="justify-between">
              <FieldLabel htmlFor="channel-on">Going out</FieldLabel>
              <Switch id="channel-on" defaultChecked={!channel?.off} />
            </Field>
          </FieldGroup>
        )
      };
    }
    case 'add-channel':
      return { title: 'Add a channel', description: 'Where a broadcast goes out to.', action: 'Connect', body: <ChannelFields /> };
    case 'broadcast': {
      const broadcast = system.broadcasts.find(each => each.id === target.id);
      return {
        title: broadcast?.name ?? 'Broadcast',
        description: broadcast && `${String(broadcast.width)}×${String(broadcast.height)} · ${broadcast.agent}`,
        action: 'Save',
        removable: true,
        body: (
          <BroadcastFields
            prefix="broadcast"
            name={broadcast?.name}
            portrait={broadcast !== undefined && broadcast.height > broadcast.width}
            recording={broadcast?.recording}
          />
        )
      };
    }
    case 'add-broadcast':
      return {
        title: 'New broadcast',
        description: 'A programme, composed from the sources, sent to channels.',
        action: 'Create',
        body: <BroadcastFields prefix="new-broadcast" name="" recording={false} />
      };
    case 'network': {
      const network = system.networks.find(each => each.id === target.id);
      const count = system.cameras.filter(camera => camera.network === target.id).length;
      return {
        title: 'Edit network',
        description: network && `${String(count)} cameras · ${network.agent}`,
        action: 'Save',
        removable: true,
        body: (
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="network-name">Name</FieldLabel>
              <Input id="network-name" defaultValue={network?.name} />
            </Field>
            <NetworkFields prefix="network" />
          </FieldGroup>
        )
      };
    }
    case 'subgroup': {
      const subgroup = system.subgroups.find(each => each.id === target.id);
      const network = system.networks.find(each => each.id === subgroup?.network);
      return {
        title: 'Edit group',
        description: subgroup && `${String(subgroup.cameras.length)} cameras · in ${network?.name ?? 'its network'}`,
        action: 'Save',
        removable: true,
        body: (
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="subgroup-name">Name</FieldLabel>
              <Input id="subgroup-name" defaultValue={subgroup?.name} />
            </Field>
            <p className="text-custom-12 text-muted-foreground">
              A group only keeps a network’s cameras in order. Removing it leaves its cameras in the network.
            </p>
          </FieldGroup>
        )
      };
    }
    case 'camera': {
      const camera = system.cameras.find(each => each.id === target.id);
      return {
        title: 'Edit camera',
        description: camera && <ReplaceDevice device={camera.device} />,
        action: 'Save',
        removable: true,
        body: (
          <CameraEditFields prefix="camera" name={camera?.name} network={camera?.network} social={camera?.social === true} />
        )
      };
    }
    case 'ingest': {
      const ingest = system.ingests.find(each => each.id === target.id);
      return {
        title: ingest?.name ?? 'Ingest',
        description: ingest?.device,
        action: 'Save',
        removable: true,
        body: (
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="ingest-name">Name</FieldLabel>
              <Input id="ingest-name" defaultValue={ingest?.name} />
            </Field>
            <IngestKeys prefix="ingest" />
          </FieldGroup>
        )
      };
    }
    case 'add-source':
      return {
        title: 'Add a source',
        description: 'What’s sending it?',
        body: (
          <div className="flex flex-col gap-2">
            <Choice icon={<VideoCameraIcon />} title="Camera" description="On a network an agent already serves">
              <div className="ml-6.5 flex flex-wrap gap-1">
                {system.networks.map(network => (
                  <Button key={network.id} variant="outline" size="xs" onClick={() => go({ kind: 'add-camera', network: network.id })}>
                    {network.name}
                  </Button>
                ))}
              </div>
            </Choice>
            <Choice
              icon={<NetworkIcon />}
              title="Network"
              description="Somewhere new: install an agent on a machine there"
              onClick={() => go({ kind: 'add-network' })}
            />
            <Choice
              icon={<ArrowSquareInIcon />}
              title="Ingest"
              description="Pushed from OBS or a phone over RTMP, from anywhere"
              onClick={() => go({ kind: 'add-ingest' })}
            />
          </div>
        )
      };
    case 'add-camera': {
      const network = system.networks.find(each => each.id === target.network);
      return {
        title: `New camera on ${network?.name ?? 'a network'}`,
        description: `Axis M3088 at 10.0.3.41, found by ${network?.agent ?? 'its agent'}.`,
        action: 'Add camera',
        body: <CameraFields prefix="new-camera" />
      };
    }
    case 'add-network':
      return {
        title: 'New network',
        description: 'Somewhere with cameras: an agent there finds them.',
        action: 'Done',
        waiting: <Connecting>Waiting for its agent</Connecting>,
        body: (
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="new-network-name">Name</FieldLabel>
              <Input id="new-network-name" defaultValue="Hospital wing" />
            </Field>
            <InstallCommand where="hospital wing" className="border-t-0 pt-0" />
          </FieldGroup>
        )
      };
    case 'add-ingest':
      return {
        title: 'New ingest',
        description: 'Paste these into OBS, or a phone’s streaming app.',
        action: 'Done',
        body: (
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="new-ingest-name">Name</FieldLabel>
              <Input id="new-ingest-name" defaultValue="Keeper’s phone" />
            </Field>
            <IngestKeys prefix="new-ingest" />
          </FieldGroup>
        )
      };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Motion: a few small parts, so the same few movements are used everywhere.

/** Things that move or resize: a soft spring that settles without much bounce. */
const SPRING: Transition = { type: 'spring', duration: 0.45, bounce: 0.12 };
/** Things that swap in place: short, and out of the way. */
const QUICK: Transition = { duration: 0.2, ease: [0.2, 0, 0, 1] };

const swaps = {
  /** Words: the old slips up and out as the new comes up from under. */
  slide: {
    initial: { opacity: 0, y: 5, filter: 'blur(3px)' },
    // The old is nearly gone before the new arrives, so the two are never both legible.
    animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { ...QUICK, delay: 0.07 } },
    exit: { opacity: 0, y: -5, filter: 'blur(3px)', transition: { duration: 0.11, ease: 'easeIn' as const } },
    transition: QUICK
  },
  /** A health dot changing: it pops, so a change of state catches the eye once. */
  pop: {
    initial: { opacity: 0, scale: 0.3 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.3 },
    transition: { type: 'spring', duration: 0.45, bounce: 0.5 }
  }
} satisfies Record<string, { initial: object; animate: object; exit: object; transition: Transition }>;

/** Whatever it holds, swapped in place whenever `id` changes; still on first draw. */
const Swap: FC<{ id: string; kind?: keyof typeof swaps; className?: string; children: ReactNode }> = ({
  id,
  kind = 'slide',
  className,
  children
}) => (
  <span className={cn('relative inline-flex min-w-0', className)}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={id} className="inline-flex min-w-0 items-center gap-[inherit]" {...swaps[kind]}>
        {children}
      </motion.span>
    </AnimatePresence>
  </span>
);

/** Something that comes and goes without moving what's around it: it fades and grows a touch. */
const Show: FC<{ when: boolean; className?: string; children: ReactNode }> = ({ when, className, children }) => (
  <AnimatePresence mode="popLayout" initial={false}>
    {when && (
      <motion.span
        key="shown"
        className={cn('inline-flex items-center', className)}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={QUICK}
      >
        {children}
      </motion.span>
    )}
  </AnimatePresence>
);

/**
 * Something that comes and goes in a stack, making room for itself: its height opens. `gap` is the stack's own gap,
 * taken back while it's shut so nothing jumps as it arrives or leaves.
 */
const Reveal: FC<{ when: boolean; gap?: number; className?: string; children: ReactNode }> = ({
  when,
  gap = 0,
  className,
  children
}) => (
  <AnimatePresence initial={false}>
    {when && (
      <motion.div
        key="revealed"
        className={className}
        style={{ overflow: 'clip' }}
        initial={{ height: 0, opacity: 0, marginTop: -gap }}
        animate={{ height: 'auto', opacity: 1, marginTop: 0 }}
        exit={{ height: 0, opacity: 0, marginTop: -gap }}
        transition={SPRING}
      >
        {children}
      </motion.div>
    )}
  </AnimatePresence>
);

/** A small control that tucks in at a row's end, widening to make its own room. */
const Tuck: FC<{ when: boolean; className?: string; children: ReactNode }> = ({ when, className, children }) => (
  <AnimatePresence initial={false}>
    {when && (
      <motion.span
        key="tucked"
        className={cn('inline-flex shrink-0 items-center justify-end', className)}
        initial={{ width: 0, opacity: 0, scale: 0.6 }}
        animate={{ width: 'auto', opacity: 1, scale: 1 }}
        exit={{ width: 0, opacity: 0, scale: 0.6 }}
        transition={SPRING}
      >
        {children}
      </motion.span>
    )}
  </AnimatePresence>
);

/** On first draw, things come up into place one after another, in `order`. */
const Rise: FC<{ order: number; className?: string; children: ReactNode }> = ({ order, className, children }) => (
  <motion.div
    className={className}
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ ...SPRING, delay: order * 0.035 }}
  >
    {children}
  </motion.div>
);

/** Gives a little under a press. */
const Press: FC<{ children: ReactNode }> = ({ children }) => (
  <motion.div whileTap={{ scale: 0.985 }} transition={{ type: 'spring', duration: 0.25, bounce: 0.3 }}>
    {children}
  </motion.div>
);

/** A network's caret: one arrow that turns, rather than two that swap. */
const Caret: FC<{ open: boolean }> = ({ open }) => (
  <motion.span
    className="flex shrink-0 text-muted-foreground"
    initial={false}
    animate={{ rotate: open ? 90 : 0 }}
    transition={SPRING}
  >
    <CaretRightIcon className="size-3" />
  </motion.span>
);

/** A group's members opening under it, one after another. */
const members: Variants = {
  shut: { height: 0, opacity: 0 },
  open: { height: 'auto', opacity: 1, transition: { ...SPRING, staggerChildren: 0.03, delayChildren: 0.03 } }
};
const member: Variants = {
  shut: { opacity: 0, y: -6 },
  open: { opacity: 1, y: 0, transition: SPRING }
};

/** A health dot that pops when its status changes. */
const Health: FC<{ status: SignalStatus }> = ({ status }) => (
  <Swap id={status} kind="pop">
    <SignalHealthDot status={status} />
  </Swap>
);

// ---------------------------------------------------------------------------------------------------------------------
// The form for a target.

/** A dialog over the map, a sheet up from the foot of the stack; going on from one form to the next slides across. */
const FormSurface: FC<{
  target: Target | null;
  wide: boolean;
  system: System;
  go: (next: Target) => void;
  onClose: () => void;
}> = ({ target, wide, system, go, onClose }) => {
  // Kept while it closes, so the form doesn't empty mid-animation.
  const last = useRef<Target | null>(null);
  if (target !== null) last.current = target;
  const shown = target ?? last.current;
  const form = shown === null ? null : formOf(shown, system, go);
  const step = shown === null ? '' : `${shown.kind}-${'id' in shown ? shown.id : ''}`;
  const open = target !== null;
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };
  const remove = form?.removable && (
    <Button variant="ghost" size="sm" className="mr-auto text-destructive" onClick={onClose}>
      <TrashIcon />
      Remove
    </Button>
  );
  const actions = (Close: typeof DialogClose | typeof SheetClose) =>
    form && (
      <>
        {remove}
        {form.waiting && <span className="mr-auto">{form.waiting}</span>}
        {!form.waiting && <Close render={<Button variant="ghost" size="sm" />}>Cancel</Close>}
        {form.action && <Close render={<Button size="sm" />}>{form.action}</Close>}
      </>
    );
  const across = {
    initial: { opacity: 0, x: 24 },
    // The old form is out of the way before the new one comes across.
    animate: { opacity: 1, x: 0, transition: { duration: 0.28, delay: 0.09, ease: [0.2, 0, 0, 1] } },
    exit: { opacity: 0, x: -24, transition: { duration: 0.12, ease: 'easeIn' } }
  } as const;
  if (wide) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="block overflow-hidden p-0 sm:max-w-md">
          {form && (
            // The dialog eases to each form's height as one takes over from another.
            <AnimateHeight transition={SPRING}>
              <div className="relative">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div key={step} className="grid gap-4 p-4" {...across}>
                    <DialogHeader>
                      <DialogTitle>{form.title}</DialogTitle>
                      {form.description && <DialogDescription render={<div />}>{form.description}</DialogDescription>}
                    </DialogHeader>
                    <div className="text-custom-13">{form.body}</div>
                    {form.action && (
                      <div className="-mx-4 -mb-4 flex items-center justify-end gap-2 border-t bg-muted/50 p-3">
                        {actions(DialogClose)}
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </AnimateHeight>
          )}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[88svh] overflow-hidden rounded-t-2xl">
        {form && (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={step} className="flex min-h-0 flex-1 flex-col" {...across}>
              <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" />
              <SheetHeader className="pb-2">
                <SheetTitle>{form.title}</SheetTitle>
                {form.description && <SheetDescription render={<div />}>{form.description}</SheetDescription>}
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 text-custom-13">{form.body}</div>
              {form.action && (
                <div className="flex items-center justify-end gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                  {actions(SheetClose)}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </SheetContent>
    </Sheet>
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// Shared bits.

/** Makes a non-button pressable by pointer and keyboard, without its press reaching what's behind it. */
function pressable(onPress: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      onPress();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      onPress();
    }
  };
}

const stop = (onPress: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  onPress();
};

const PRESSABLE =
  'cursor-pointer outline-none transition-[opacity,background-color,border-color] duration-200 focus-visible:ring-2 focus-visible:ring-ring';
const PICKED = '!border-foreground/25 !bg-muted';

interface ViewProps {
  system: System;
  open: string[];
  /** A thing whose path stays in full; the rest fades. */
  picked?: string;
  editing: boolean;
  onPick: (id: string) => void;
  onToggle: (group: string) => void;
  onToggleSub: (subgroup: string) => void;
  onEdit: (target: Target) => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Wide: the map.

/** A rail that slides in between the columns when a second gateway turns up, and back out when it goes. */
const MotionRail = motion.create(SignalRail);

const railShut = { width: 0, marginLeft: -40, marginRight: -40, opacity: 0 };
const railOpen = { width: 24, marginLeft: -32, marginRight: -32, opacity: 1 };

interface CameraGroupProps extends Pick<ViewProps, 'open' | 'onPick' | 'onToggle' | 'onToggleSub' | 'onEdit'> {
  group: Group;
  editing: boolean;
  picked?: string;
  /** Everything on the picked path, when something is picked. */
  path: Set<string> | null;
}

/**
 * What's listed under a label, opening on a spring, one after another. Wider and deeper than its rows by their
 * shadows, which the clip would otherwise cut; the depth is taken back by a margin that opens with it, so nothing
 * jumps as it arrives or leaves.
 */
const Members: FC<{ open: boolean; className?: string; children: ReactNode }> = ({ open, className, children }) => (
  <AnimatePresence initial={false}>
    {open && (
      <motion.div
        key="members"
        className="-mx-2"
        style={{ overflow: 'clip' }}
        variants={{ shut: { ...members.shut, marginBottom: 0 }, open: { ...members.open, marginBottom: -8 } }}
        initial="shut"
        animate="open"
        exit="shut"
        transition={SPRING}
      >
        <div className={cn('flex flex-col gap-1.5 px-2 pt-1.5 pb-2', className)}>{children}</div>
      </motion.div>
    )}
  </AnimatePresence>
);

interface CameraPillProps extends Pick<ViewProps, 'onPick' | 'onEdit'> {
  group: Group;
  source: SampleSource;
  editing: boolean;
  picked?: string;
}

const CameraPill: FC<CameraPillProps> = ({ group, source, editing, picked, onPick, onEdit }) => (
  <motion.div variants={member} whileTap={{ scale: 0.985 }} transition={{ type: 'spring', duration: 0.25, bounce: 0.3 }}>
    <SignalNode
      id={source.id}
      status={seen(group, source)}
      variant="pill"
      {...pressable(() =>
        editing ? onEdit({ kind: group.id === INGESTS_ID ? 'ingest' : 'camera', id: source.id }) : onPick(source.id)
      )}
      className={cn(PRESSABLE, 'hover:bg-muted/60', picked === source.id && PICKED)}
    >
      <SignalNodeIcon>{sourceIcons[source.kind]}</SignalNodeIcon>
      <SignalNodeTitle className="flex-1">{source.name}</SignalNodeTitle>
      <Show when={seen(group, source) === 'failing'}>
        <SignalNodeFlag tone="destructive">Not sending</SignalNodeFlag>
      </Show>
      <Health status={seen(group, source)} />
    </SignalNode>
  </motion.div>
);

const CameraGroup: FC<CameraGroupProps> = ({ group, open, editing, picked, path, onPick, onToggle, onToggleSub, onEdit }) => {
  const loose = group.id === INGESTS_ID;
  const down = isDown(group);
  const shown = loose || open.includes(group.id);
  const onPath = (id: string, sources: SampleSource[]) =>
    path === null || path.has(id) || sources.some(source => path.has(source.id));
  const lit = onPath(group.id, group.sources);
  const failing = group.sources.filter(source => seen(group, source) === 'failing').length;
  const meta = group.network
    ? down
      ? `${group.network.agent} not answering`
      : failing > 0
        ? `${String(failing)} not sending`
        : group.network.agent
    : 'pushed from anywhere';
  const toggle = loose ? {} : pressable(() => onToggle(group.id));
  const pill = (source: SampleSource) => (
    <CameraPill key={source.id} group={group} source={source} editing={editing} picked={picked} onPick={onPick} onEdit={onEdit} />
  );
  return (
    // Positioned, so its join sits at its label rather than at the top of the map.
    <SignalGroup className="relative gap-0">
      {shown && !loose && <SignalJoin id={`join-${group.id}`} lifted className="top-2.5 left-0" />}
      {/* One label, open or shut, so its caret can turn; the network's own wire runs from it either way. */}
      <SignalNode
        id={group.id}
        status={groupStatus(group)}
        {...toggle}
        className={cn('h-5 gap-1.5 rounded-sm text-custom-12', !loose && PRESSABLE, lit && '!opacity-100')}
      >
        <SignalNodeIcon className={cn('transition-colors duration-300', down && 'text-destructive')}>
          {group.network ? down ? <NetworkXIcon /> : <NetworkIcon /> : <ArrowSquareInIcon />}
        </SignalNodeIcon>
        <span className="font-medium">{group.network?.name ?? 'Ingests'}</span>
        {!loose && <Caret open={shown} />}
        <Show when={!shown} className="ml-auto">
          <SignalDots statuses={group.sources.map(source => seen(group, source))} className="flex-nowrap" />
        </Show>
        <Tuck when={editing && !loose} className={cn('-my-1 -mr-1.5', shown && 'ml-auto')}>
          <MoreButton onClick={stop(() => onEdit({ kind: 'network', id: group.id }))} />
        </Tuck>
      </SignalNode>
      {/* Under the name, not beside it, so the name's line has room for the dots whatever the column's width. */}
      <div
        className={cn(
          'flex pl-5.5 text-custom-11 transition-opacity duration-200',
          down || failing > 0 ? 'text-destructive' : 'text-muted-foreground',
          !lit && 'opacity-25'
        )}
      >
        <Swap id={meta} className="truncate">
          {meta}
        </Swap>
      </div>
      <Members open={shown}>
        {group.subgroups.map(sub => {
          const subOpen = open.includes(sub.id);
          const subFailing = sub.sources.filter(source => seen(group, source) === 'failing').length;
          return (
            // A subgroup: a label among the cameras, shut to a line as its network is; its wire, and its cameras'
            // when open, run to the network's point on the rail like any camera's.
            <motion.div key={sub.id} variants={member} className="flex flex-col">
              <SignalNode
                id={sub.id}
                status={subStatus(group, sub)}
                {...pressable(() => onToggleSub(sub.id))}
                className={cn(
                  'h-7 gap-1.5 rounded-md text-custom-12',
                  PRESSABLE,
                  onPath(sub.id, sub.sources) && '!opacity-100'
                )}
              >
                <SignalNodeIcon>
                  <FolderSimpleIcon />
                </SignalNodeIcon>
                <span className="truncate">{sub.name}</span>
                <Caret open={subOpen} />
                <Show when={subFailing > 0}>
                  <span className="text-custom-11 text-destructive">{subFailing} not sending</span>
                </Show>
                <Show when={!subOpen} className="ml-auto">
                  <SignalDots statuses={sub.sources.map(source => seen(group, source))} className="flex-nowrap" />
                </Show>
                <Tuck when={editing} className={cn('-my-1 -mr-1.5', subOpen && 'ml-auto')}>
                  <MoreButton onClick={stop(() => onEdit({ kind: 'subgroup', id: sub.id }))} />
                </Tuck>
              </SignalNode>
              <Members open={subOpen} className="pt-0.5 pl-6">
                {sub.sources.map(pill)}
              </Members>
            </motion.div>
          );
        })}
        {group.ungrouped.map(pill)}
      </Members>
    </SignalGroup>
  );
};

const channelNote = (channel: SampleChannel): { id: string; tone?: 'warning' | 'destructive'; body: ReactNode } | null => {
  if (channel.status === 'degraded') return { id: 'degraded', tone: 'warning', body: 'Dropping frames' };
  if (channel.status === 'affected') return { id: 'affected', tone: 'destructive', body: 'Its broadcast is down' };
  if (channel.viewers === undefined) return null;
  return {
    id: 'watching',
    body: (
      <>
        <EyeIcon />
        {channel.viewers.toLocaleString('en-GB')} watching
      </>
    )
  };
};

/**
 * The three columns share the map's width equally, between a floor (below it the map scrolls sideways) and a ceiling
 * (past it the map stops growing and keeps to the left); the gaps and rails between them stay as they are.
 */
const COLUMN = 'min-w-46 max-w-96 flex-1 basis-0';

const MapView: FC<ViewProps> = ({ system, open, picked, editing, onPick, onToggle, onToggleSub, onEdit }) => {
  const groups = groupsOf(system);
  const links = linksOf(system, open);
  const path = picked === undefined ? null : pathThrough(picked, links);
  const rails = [...new Set(['gateway', ...Object.values(system.gateways)])];
  const sourceCount = system.cameras.length + system.ingests.length;
  return (
    <SignalMap highlight={picked} className="min-w-0 px-2 pt-1 pb-6">
      <SignalColumn className={COLUMN}>
        <SignalColumnHeader count={system.channels.length}>Channels</SignalColumnHeader>
        <SignalColumnContent>
          {system.channels.map((channel, index) => {
            const note = channelNote(channel);
            return (
              <Rise key={channel.id} order={index}>
                <Press>
                  <SignalNode
                    id={channel.id}
                    status={channel.status}
                    off={channel.off}
                    {...pressable(() => (editing ? onEdit({ kind: 'channel', id: channel.id }) : onPick(channel.id)))}
                    className={cn(
                      PRESSABLE,
                      '-mx-2 w-[calc(100%+1rem)] rounded-md px-2 hover:bg-muted/60',
                      picked === channel.id && 'bg-muted'
                    )}
                  >
                    <SignalNodeIcon>{platformIcons[channel.platform]}</SignalNodeIcon>
                    <SignalNodeBody>
                      <SignalNodeTitle>{channel.handle}</SignalNodeTitle>
                      {note && (
                        <Swap id={note.id}>
                          <SignalNodeMeta tone={note.tone}>{note.body}</SignalNodeMeta>
                        </Swap>
                      )}
                    </SignalNodeBody>
                    <Show when={!channel.off && channel.status !== 'affected'}>
                      <SignalBars level={channel.level} status={channel.status} />
                    </Show>
                  </SignalNode>
                </Press>
              </Rise>
            );
          })}
          <Reveal when={editing} gap={12}>
            <AddPlaceholder onClick={() => onEdit({ kind: 'add-channel' })}>Add channel</AddPlaceholder>
          </Reveal>
        </SignalColumnContent>
      </SignalColumn>
      <SignalColumn className={COLUMN}>
        <SignalColumnHeader count={system.broadcasts.length}>Broadcasts</SignalColumnHeader>
        <SignalColumnContent className="gap-4">
          {system.broadcasts.map((broadcast, index) => {
            const failing = broadcast.status === 'failing';
            return (
              <Rise key={broadcast.id} order={3 + index}>
                <Press>
                  <SignalNode
                    id={broadcast.id}
                    status={broadcast.status}
                    variant="card"
                    {...pressable(() =>
                      editing ? onEdit({ kind: 'broadcast', id: broadcast.id }) : onPick(broadcast.id)
                    )}
                    className={cn('items-start', PRESSABLE, picked === broadcast.id && PICKED)}
                  >
                    <SignalAspect width={broadcast.width} height={broadcast.height} />
                    <SignalNodeBody>
                      <SignalNodeTitle className="font-medium">{broadcast.name}</SignalNodeTitle>
                      <Swap id={failing ? 'failing' : 'shape'}>
                        {failing ? (
                          <SignalNodeMeta tone="destructive">Renderer not answering</SignalNodeMeta>
                        ) : (
                          <SignalNodeMeta>
                            {broadcast.width}×{broadcast.height}
                          </SignalNodeMeta>
                        )}
                      </Swap>
                      <Reveal when={broadcast.recording && !failing}>
                        <SignalNodeFlag tone="recording">Recording</SignalNodeFlag>
                      </Reveal>
                    </SignalNodeBody>
                    <Tuck when={editing} className="-my-1 -mr-1.5">
                      <MoreButton onClick={stop(() => onEdit({ kind: 'broadcast', id: broadcast.id }))} />
                    </Tuck>
                  </SignalNode>
                </Press>
              </Rise>
            );
          })}
          <Reveal when={editing} gap={16}>
            <AddPlaceholder onClick={() => onEdit({ kind: 'add-broadcast' })}>Add broadcast</AddPlaceholder>
          </Reveal>
        </SignalColumnContent>
      </SignalColumn>
      <AnimatePresence initial>
        {rails.map(id => (
          <MotionRail
            key={id}
            id={id}
            gather="left"
            icon={RAILS[id]?.icon}
            label={RAILS[id]?.label}
            // The cloud's rail is always there, and only fades up with the page; any other makes room for itself.
            initial={id === 'gateway' ? { ...railOpen, opacity: 0 } : railShut}
            animate={railOpen}
            exit={railShut}
            transition={SPRING}
          />
        ))}
      </AnimatePresence>
      <SignalColumn className={COLUMN}>
        <SignalColumnHeader count={sourceCount}>Sources</SignalColumnHeader>
        <SignalColumnContent className="gap-5">
          {groups.map((group, index) => (
            <Rise key={group.id} order={5 + index}>
              <CameraGroup
                group={group}
                open={open}
                editing={editing}
                picked={picked}
                path={path}
                onPick={onPick}
                onToggle={onToggle}
                onToggleSub={onToggleSub}
                onEdit={onEdit}
              />
            </Rise>
          ))}
          <Reveal when={editing} gap={20}>
            <AddPlaceholder onClick={() => onEdit({ kind: 'add-source' })}>Add source</AddPlaceholder>
          </Reveal>
        </SignalColumnContent>
      </SignalColumn>
      <SignalLinks links={links} animated />
    </SignalMap>
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// Narrow: the quiet stack.

const ROW = 'transition-colors duration-200';

const TierTitle: FC<{ children: ReactNode; editing: boolean; onAdd: () => void }> = ({ children, editing, onAdd }) => (
  <SignalTierHeader className="px-1">
    <SignalTierTitle>{children}</SignalTierTitle>
    <Show when={editing} className="ml-auto">
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onAdd}>
        <PlusIcon />
        Add
      </Button>
    </Show>
  </SignalTierHeader>
);

const StackView: FC<ViewProps> = ({ system, open, picked, editing, onPick, onToggle, onToggleSub, onEdit }) => {
  const groups = groupsOf(system);
  const links = linksOf(system, open);
  const path = picked === undefined ? null : pathThrough(picked, links);
  const faded = (id: string) => path !== null && !path.has(id);
  const press = (id: string, target: Target) => pressable(() => (editing ? onEdit(target) : onPick(id)));
  /** A row's end: its health, or a chevron while editing. */
  const trail = (health: ReactNode) => (
    <SignalListTrail>
      <Swap id={editing ? 'editing' : 'health'} className="gap-2">
        {editing ? <CaretRightIcon /> : health}
      </Swap>
    </SignalListTrail>
  );
  /** A camera or ingest under its network, or further in under its subgroup. */
  const row = (group: Group, source: SampleSource, indent: string) => (
    <motion.div key={source.id} variants={member}>
      <SignalListItem
        picked={picked === source.id}
        faded={faded(source.id)}
        {...press(source.id, { kind: group.id === INGESTS_ID ? 'ingest' : 'camera', id: source.id })}
        className={cn('min-h-9 border-t border-border/60 py-1.5 text-custom-12', indent, PRESSABLE, ROW)}
      >
        <span aria-hidden className="[&_svg]:size-3.5">
          {sourceIcons[source.kind]}
        </span>
        <SignalListText>
          {source.name}
          <Reveal when={seen(group, source) === 'failing'}>
            <SignalListNote tone="destructive">Not sending</SignalListNote>
          </Reveal>
        </SignalListText>
        {trail(<Health status={seen(group, source)} />)}
      </SignalListItem>
    </motion.div>
  );
  return (
    <SignalStack className="gap-6">
      <Rise order={0}>
        <SignalTier>
          <TierTitle editing={editing} onAdd={() => onEdit({ kind: 'add-channel' })}>
            Channels
          </TierTitle>
          <SignalList>
            {system.channels.map(channel => (
              <SignalListItem
                key={channel.id}
                picked={picked === channel.id}
                faded={faded(channel.id)}
                {...press(channel.id, { kind: 'channel', id: channel.id })}
                className={cn(PRESSABLE, ROW)}
              >
                <SignalNodeIcon>{platformIcons[channel.platform]}</SignalNodeIcon>
                <SignalListText>
                  <span className="truncate">{channel.handle}</span>
                  <Reveal when={channel.status === 'degraded' || channel.status === 'affected'}>
                    <SignalListNote tone={channel.status === 'affected' ? 'destructive' : 'warning'}>
                      {channel.status === 'affected' ? 'Its broadcast is down' : 'Dropping frames'}
                    </SignalListNote>
                  </Reveal>
                </SignalListText>
                {trail(
                  channel.status === 'affected' ? (
                    <Health status="affected" />
                  ) : (
                    <SignalBars level={channel.level} status={channel.status} />
                  )
                )}
              </SignalListItem>
            ))}
          </SignalList>
        </SignalTier>
      </Rise>
      <Rise order={2}>
        <SignalTier>
          <TierTitle editing={editing} onAdd={() => onEdit({ kind: 'add-broadcast' })}>
            Broadcasts
          </TierTitle>
          <SignalList>
            {system.broadcasts.map(broadcast => {
              const isPicked = picked === broadcast.id;
              const failing = broadcast.status === 'failing';
              const channels = links.filter(link => link.from === broadcast.id).length;
              const feeding = groups
                .flatMap(group => group.sources)
                .filter(source => broadcast.id === 'full' || source.social).length;
              return (
                <SignalListItem
                  key={broadcast.id}
                  picked={isPicked}
                  faded={faded(broadcast.id)}
                  {...press(broadcast.id, { kind: 'broadcast', id: broadcast.id })}
                  className={cn(PRESSABLE, ROW)}
                >
                  <SignalAspect width={broadcast.width} height={broadcast.height} />
                  <SignalListText>
                    {broadcast.name}
                    <Reveal when={failing}>
                      <SignalListNote tone="destructive">Renderer not answering</SignalListNote>
                    </Reveal>
                    <Reveal when={isPicked && !failing}>
                      <SignalListNote>
                        To {channels} channel{channels === 1 ? '' : 's'} · from {feeding} sources
                      </SignalListNote>
                    </Reveal>
                  </SignalListText>
                  {trail(
                    <>
                      {broadcast.recording && !failing && <SignalNodeFlag tone="recording">Rec</SignalNodeFlag>}
                      <Health status={broadcast.status} />
                    </>
                  )}
                </SignalListItem>
              );
            })}
          </SignalList>
        </SignalTier>
      </Rise>
      <Rise order={4}>
        <SignalTier>
          <TierTitle editing={editing} onAdd={() => onEdit({ kind: 'add-source' })}>
            Sources
          </TierTitle>
          <SignalList>
            {groups.map(group => {
              const down = isDown(group);
              const loose = group.id === INGESTS_ID;
              const isOpen = shownOpen(group, open);
              const failing = group.sources.filter(source => seen(group, source) === 'failing').length;
              const headFaded = faded(group.id) && !group.sources.some(source => path?.has(source.id));
              return (
                <div key={group.id} className="flex flex-col">
                  <SignalListItem
                    faded={headFaded}
                    {...(loose ? {} : pressable(() => onToggle(group.id)))}
                    className={cn(!loose && PRESSABLE, ROW)}
                  >
                    <SignalNodeIcon className={cn('transition-colors duration-300', down && 'text-destructive')}>
                      {group.network ? down ? <NetworkXIcon /> : <NetworkIcon /> : <ArrowSquareInIcon />}
                    </SignalNodeIcon>
                    <SignalListText>
                      <span className="flex items-center gap-1.5 truncate">
                        {group.network?.name ?? 'Ingests'}
                        {!loose && <Caret open={isOpen} />}
                      </span>
                      <Reveal when={down || failing > 0}>
                        <SignalListNote tone="destructive">
                          {down ? `${group.network?.agent ?? 'Its agent'} not answering` : `${String(failing)} not sending`}
                        </SignalListNote>
                      </Reveal>
                    </SignalListText>
                    <SignalListTrail>
                      <Show when={!isOpen}>
                        <SignalDots
                          statuses={group.sources.map(source => seen(group, source))}
                          className="max-w-28 justify-end"
                        />
                      </Show>
                      <Tuck when={editing && !loose}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Edit ${group.network?.name ?? 'network'}`}
                          onClick={stop(() => onEdit({ kind: 'network', id: group.id }))}
                        >
                          <DotsThreeIcon weight="bold" />
                        </Button>
                      </Tuck>
                    </SignalListTrail>
                  </SignalListItem>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        key="members"
                        className="flex flex-col"
                        style={{ overflow: 'clip' }}
                        variants={members}
                        initial="shut"
                        animate="open"
                        exit="shut"
                        transition={SPRING}
                      >
                        {group.subgroups.map(sub => {
                          const subOpen = open.includes(sub.id);
                          const subFailing = sub.sources.filter(source => seen(group, source) === 'failing').length;
                          return (
                            <motion.div key={sub.id} variants={member} className="flex flex-col">
                              <SignalListItem
                                faded={faded(sub.id) && !sub.sources.some(source => path?.has(source.id))}
                                {...pressable(() => onToggleSub(sub.id))}
                                className={cn('min-h-9 border-t border-border/60 py-1.5 pl-10 text-custom-12', PRESSABLE, ROW)}
                              >
                                <span aria-hidden className="[&_svg]:size-3.5">
                                  <FolderSimpleIcon />
                                </span>
                                <SignalListText>
                                  <span className="flex items-center gap-1.5 truncate">
                                    {sub.name}
                                    <Caret open={subOpen} />
                                  </span>
                                  <Reveal when={subFailing > 0}>
                                    <SignalListNote tone="destructive">{subFailing} not sending</SignalListNote>
                                  </Reveal>
                                </SignalListText>
                                <SignalListTrail>
                                  <Show when={!subOpen}>
                                    <SignalDots
                                      statuses={sub.sources.map(source => seen(group, source))}
                                      className="max-w-28 justify-end"
                                    />
                                  </Show>
                                  <Tuck when={editing}>
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      aria-label={`Edit ${sub.name}`}
                                      onClick={stop(() => onEdit({ kind: 'subgroup', id: sub.id }))}
                                    >
                                      <DotsThreeIcon weight="bold" />
                                    </Button>
                                  </Tuck>
                                </SignalListTrail>
                              </SignalListItem>
                              <AnimatePresence initial={false}>
                                {subOpen && (
                                  <motion.div
                                    key="members"
                                    className="flex flex-col"
                                    style={{ overflow: 'clip' }}
                                    variants={members}
                                    initial="shut"
                                    animate="open"
                                    exit="shut"
                                    transition={SPRING}
                                  >
                                    {sub.sources.map(source => row(group, source, 'pl-[4.25rem]'))}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </motion.div>
                          );
                        })}
                        {group.ungrouped.map(source => row(group, source, 'pl-10'))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </SignalList>
        </SignalTier>
      </Rise>
    </SignalStack>
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// The page.

const WIDE_QUERY = '(min-width: 880px)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Wide enough for the map; narrower gets the stack. */
function useWide() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true
  );
}

/** Pick a state for the system underneath; a button beside it steps to the next. */
const ScenarioPicker: FC<{ scenario: Scenario; onChange: (key: string) => void }> = ({ scenario, onChange }) => {
  const index = SCENARIOS.indexOf(scenario);
  const next = SCENARIOS[(index + 1) % SCENARIOS.length];
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-w-56 justify-between sm:max-w-none" />}>
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-muted-foreground">State:</span>
            <Swap id={scenario.key} className="truncate">
              {scenario.label}
            </Swap>
          </span>
          <CaretDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel>The system underneath</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={scenario.key} onValueChange={value => onChange(String(value))}>
              {SCENARIOS.map(each => (
                <DropdownMenuRadioItem key={each.key} value={each.key} className="items-start">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{each.label}</span>
                    <span className="text-muted-foreground">{each.note}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {next && (
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={`Next state: ${next.label}`} />}
            onClick={() => onChange(next.key)}
          >
            {/* A nudge forward each time it steps on. */}
            <motion.span
              key={scenario.key}
              className="flex"
              initial={{ x: -5, opacity: 0.3 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.4 }}
            >
              <ArrowRightIcon />
            </motion.span>
          </TooltipTrigger>
          <TooltipContent>Next: {next.label}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};

const SignalPrototypeMotion: FC = () => {
  const [params, setParams] = useSearchParams();
  const scenario = SCENARIOS.find(each => each.key === params.get('state')) ?? SCENARIOS[0];
  if (scenario === undefined) throw new Error('There are no scenarios.');
  const system = scenario.system;
  const wide = useWide();
  const [open, setOpen] = useState<string[]>(['outdoor']);
  const [picked, setPicked] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);

  // A pick that's no longer on the page (its network shut since) is dropped rather than fading everything.
  const onPage = new Set([
    ...system.channels.map(channel => channel.id),
    ...system.broadcasts.map(broadcast => broadcast.id),
    ...feedsOf(system, open).map(feed => feed.id)
  ]);
  const pick = picked !== undefined && onPage.has(picked) ? picked : undefined;

  const setScenario = (key: string) =>
    setParams(
      current => {
        current.set('state', key);
        return current;
      },
      { replace: true, preventScrollReset: true }
    );
  // One network open at a time, and one subgroup in it: opening one shuts whichever was open. `open` holds both.
  const onToggle = (group: string) => setOpen(current => (current.includes(group) ? [] : [group]));
  const subgroupIds = new Set(system.subgroups.map(subgroup => subgroup.id));
  const onToggleSub = (subgroup: string) =>
    setOpen(current => {
      const networks = current.filter(id => !subgroupIds.has(id));
      return current.includes(subgroup) ? networks : [...networks, subgroup];
    });
  const onPick = (id: string) => setPicked(current => (current === id ? undefined : id));
  const onEdit = (next: Target) => setTarget(next);
  const toggleEditing = () => {
    setEditing(current => !current);
    setPicked(undefined);
  };

  const view: ViewProps = { system, open, picked: pick, editing, onPick, onToggle, onToggleSub, onEdit };
  const failing = [
    ...system.networks.filter(network => network.status === 'failing'),
    ...system.cameras.filter(camera => camera.status === 'failing'),
    ...system.broadcasts.filter(broadcast => broadcast.status === 'failing'),
    ...system.channels.filter(channel => channel.status === 'degraded')
  ].length;
  const hint = editing
    ? `Press anything to edit it; ${wide ? 'the dashed rows' : 'each list’s Add'} adds one. Nothing saves.`
    : 'Press anything to follow its path; press a network, or a group in it, to open it, one at a time. Made-up data.';

  return (
    // Anyone who has asked their device for less motion gets the page without its movement.
    <MotionConfig reducedMotion="user">
      <main className="flex min-h-svh flex-col bg-background">
        <header className="sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background/90 px-4 py-3 backdrop-blur lg:px-8">
          <div className="flex w-full min-w-0 flex-col sm:w-auto sm:flex-1">
            <h1 className="flex items-center gap-2 text-custom-15 font-semibold">
              Signal
              <Swap id={String(failing)}>
                <Badge variant={failing > 0 ? 'destructive' : 'secondary'}>
                  {failing > 0 ? `${String(failing)} need${failing === 1 ? 's' : ''} attention` : 'All healthy'}
                </Badge>
              </Swap>
            </h1>
            <Swap id={scenario.key} className="text-custom-12 text-muted-foreground">
              <span className="sm:truncate">{scenario.note}</span>
            </Swap>
          </div>
          <div className="mr-auto sm:mr-0">
            <ScenarioPicker scenario={scenario} onChange={setScenario} />
          </div>
          {/* One control that grows a label when editing, rather than two that swap. */}
          <div
            className={cn(
              'flex items-center rounded-lg border p-1 transition-colors duration-300',
              editing ? 'border-border bg-popover' : 'border-transparent'
            )}
          >
            <AnimatePresence initial={false}>
              {editing && (
                <motion.span
                  key="editing"
                  className="flex overflow-hidden whitespace-nowrap"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 'auto', opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={SPRING}
                >
                  <span className="flex items-center gap-1.5 px-2 text-custom-12 text-muted-foreground">
                    <PencilSimpleIcon />
                    Editing
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
            <Button variant={editing ? 'default' : 'outline'} size="sm" onClick={toggleEditing}>
              <Swap id={editing ? 'done' : 'edit'} className="gap-1.5">
                {editing ? (
                  'Done'
                ) : (
                  <>
                    <PencilSimpleIcon />
                    Edit
                  </>
                )}
              </Swap>
            </Button>
          </div>
        </header>
        {/* A press on the empty page lets go of the pick. */}
        <div className="flex-1 px-4 py-6 lg:px-8 lg:py-8" onClick={() => setPicked(undefined)}>
          {wide ? <MapView {...view} /> : <StackView {...view} />}
          <p className="mt-6 text-custom-11 text-muted-foreground">
            <Swap id={hint}>{hint}</Swap>
          </p>
        </div>
        <FormSurface target={target} wide={wide} system={system} go={onEdit} onClose={() => setTarget(null)} />
      </main>
    </MotionConfig>
  );
};

export default SignalPrototypeMotion;
