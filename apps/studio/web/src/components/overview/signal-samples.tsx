import type { ReactNode } from 'react';
import {
  ArrowSquareInIcon,
  DesktopIcon,
  TiktokLogoIcon,
  TwitchLogoIcon,
  VideoCameraIcon,
  YoutubeLogoIcon
} from '@phosphor-icons/react';

import type { SignalStatus } from '@/components/overview/signal-map';

// Made-up channels, broadcasts and sources for the signal map galleries: a sanctuary's four channels, its two
// broadcasts, and the cameras and ingests feeding them. Design data only; nothing reads the API.

export type Platform = 'twitch' | 'youtube' | 'tiktok';

export interface SampleChannel {
  id: string;
  platform: Platform;
  handle: string;
  status: SignalStatus;
  level: 0 | 1 | 2 | 3;
  viewers?: number;
  off?: boolean;
}

export interface SampleBroadcast {
  id: string;
  name: string;
  width: number;
  height: number;
  recording: boolean;
  agent: string;
  status: SignalStatus;
}

export interface SampleSource {
  id: string;
  name: string;
  device: string;
  kind: 'camera' | 'obs' | 'rtmp';
  status: SignalStatus;
  /** The device's own state, when it differs from the stream's. */
  deviceStatus?: SignalStatus;
  social?: boolean;
  /** The network a camera sits on; ingests push from anywhere and have none. */
  network?: string;
}

export interface SampleNetwork {
  id: string;
  name: string;
  /** The agent serving it. */
  agent: string;
  /** The agent's state: when it's down, nothing on the network can be seen. */
  status: SignalStatus;
}

export const platformIcons = {
  twitch: <TwitchLogoIcon weight="fill" />,
  youtube: <YoutubeLogoIcon weight="fill" />,
  tiktok: <TiktokLogoIcon weight="fill" />
} satisfies Record<Platform, ReactNode>;

export const platformNames = { twitch: 'Twitch', youtube: 'YouTube', tiktok: 'TikTok' } satisfies Record<Platform, string>;

export const sourceIcons = {
  camera: <VideoCameraIcon weight="fill" />,
  obs: <DesktopIcon />,
  rtmp: <ArrowSquareInIcon />
};

export const CHANNELS: SampleChannel[] = [
  { id: 'twitch-sanctuary', platform: 'twitch', handle: '/alveussanctuary', status: 'degraded', level: 2, viewers: 1843 },
  { id: 'twitch-gg', platform: 'twitch', handle: '/alveusgg', status: 'ok', level: 3, viewers: 212 },
  { id: 'youtube', platform: 'youtube', handle: '@AlveusSanctuary', status: 'ok', level: 3, viewers: 96 },
  { id: 'tiktok', platform: 'tiktok', handle: '@AlveusSanctuary', status: 'ok', level: 3, viewers: 408 }
];

export const BROADCASTS: SampleBroadcast[] = [
  {
    id: 'full',
    name: 'Full broadcast',
    width: 1920,
    height: 1080,
    recording: true,
    agent: 'Windows OBS agent',
    status: 'ok'
  },
  {
    id: 'social',
    name: 'Social media broadcast',
    width: 1080,
    height: 1920,
    recording: false,
    agent: 'Windows OBS agent',
    status: 'ok'
  }
];

export const NETWORKS: SampleNetwork[] = [
  { id: 'main', name: 'Main building', agent: 'pi-03', status: 'ok' },
  { id: 'outdoor', name: 'Outdoor enclosures', agent: 'pi-04', status: 'ok' },
  { id: 'barn', name: 'Barn and pasture', agent: 'pi-05', status: 'ok' }
];

export const SOURCES: SampleSource[] = [
  { id: 'serval', name: 'Serval (west)', device: 'Axis P1468 · pi-03', kind: 'camera', status: 'ok', social: true, network: 'main' },
  { id: 'fox', name: 'Fox den', device: 'Axis M3088 · pi-04', kind: 'camera', status: 'ok', social: true, network: 'outdoor' },
  { id: 'crow', name: 'Crow outdoor', device: 'Reolink RLC-811 · pi-04', kind: 'camera', status: 'ok', network: 'outdoor' },
  { id: 'marmoset', name: 'Marmoset indoor', device: 'Axis P1468 · pi-03', kind: 'camera', status: 'ok', social: true, network: 'main' },
  { id: 'pasture', name: 'Pasture', device: 'Reolink RLC-811 · pi-05', kind: 'camera', status: 'ok', network: 'barn' },
  { id: 'parrots', name: 'Parrots', device: 'Axis M3088 · pi-03', kind: 'camera', status: 'ok', network: 'main' }
];

export const INGESTS: SampleSource[] = [
  { id: 'studio', name: 'Studio desk', device: 'OBS on studio-pc', kind: 'obs', status: 'ok' },
  { id: 'field', name: 'Field phone', device: 'RTMP push', kind: 'rtmp', status: 'unknown' }
];

/** Sources by network, in the networks' order. */
export function byNetwork(sources: SampleSource[], networks: SampleNetwork[] = NETWORKS) {
  return networks.map(network => ({ network, sources: sources.filter(source => source.network === network.id) }));
}

export const MANY_SOURCES: SampleSource[] = [
  ...SOURCES,
  ...(
    [
      ['Chickens', 'barn'],
      ['Wolf run', 'outdoor'],
      ['Reptile room', 'main'],
      ['Nuthouse', 'main'],
      ['Pond', 'outdoor'],
      ['Insect lab', 'main'],
      ['Pig pen', 'barn'],
      ['Rat cage', 'main']
    ] as const
  ).map(
    ([name, network], index): SampleSource => ({
      id: `extra-${String(index)}`,
      name,
      device: `Axis M3088 · ${NETWORKS.find(each => each.id === network)?.agent ?? ''}`,
      kind: 'camera',
      status: index === 2 ? 'unknown' : 'ok',
      network
    })
  )
];


/** The cameras the signal page draws: every one of them, by network. */
export const NETWORK_SOURCES: SampleSource[] = MANY_SOURCES;

/** A camera being added to the main building, and an ingest just made: the editing galleries' new rows. */
export const NEW_CAMERA: SampleSource = {
  id: 'otter',
  name: 'Otter pool',
  device: 'Axis M3088 · 10.0.3.41',
  kind: 'camera',
  status: 'unknown',
  network: 'main'
};

export const NEW_INGEST: SampleSource = { id: 'keeper', name: "Keeper's phone", device: 'RTMP push', kind: 'rtmp', status: 'unknown' };
