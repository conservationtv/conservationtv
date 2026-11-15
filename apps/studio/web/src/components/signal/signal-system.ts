import type { Status } from '@/components/common/status';

// What the signal view draws: an organisation's channels, the broadcasts that go out to them, the gateways those are
// composed at, and the sources that feed them. Plain data; a page gets it from wherever it likes and hands it to
// <Signal>.

/** How a thing or a link is doing: the topology's four statuses, and degraded, for working but not well. */
export type SignalStatus = Status | 'degraded';

/** Where a channel is: one of the platforms, or any RTMP destination entered by hand. */
export type SignalPlatform = 'twitch' | 'youtube' | 'tiktok' | 'rtmp';

export const PLATFORM_NAMES = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  rtmp: 'RTMP'
} satisfies Record<SignalPlatform, string>;

/** Somewhere a broadcast goes out to. */
export interface SignalChannel {
  id: string;
  platform: SignalPlatform;
  handle: string;
  /** The broadcast it sends. */
  broadcast: string;
  status: SignalStatus;
  /** How well it is receiving: how many of its three bars are full. */
  level: 0 | 1 | 2 | 3;
  viewers?: number;
  /** In place, but switched off. */
  off?: boolean;
}

/** A programme, composed from the sources, sent to channels. */
export interface SignalBroadcast {
  id: string;
  name: string;
  width: number;
  height: number;
  recording: boolean;
  agent: string;
  status: SignalStatus;
}

/** A camera on a network, or an ingest pushed from anywhere: a desk running OBS, an RTMP push, a member's browser. */
export interface SignalSource {
  id: string;
  name: string;
  device: string;
  kind: 'camera' | 'obs' | 'rtmp' | 'browser';
  status: SignalStatus;
  /** The broadcasts it feeds. */
  feeds: string[];
  /** The network a camera sits on; ingests push from anywhere and have none. */
  network?: string;
}

/** Somewhere with cameras, and the agent serving it. */
export interface SignalNetwork {
  id: string;
  name: string;
  agent: string;
  /** The agent's state: when it's down, nothing on the network can be seen. */
  status: SignalStatus;
}

/** A named handful of a network's cameras: organisation only, nothing to do with how they're wired. */
export interface SignalSubgroup {
  id: string;
  name: string;
  network: string;
  cameras: string[];
}

/** Where broadcasts are composed: a rail on the map, which the sources' links run along. */
export interface SignalGateway {
  id: string;
  name: string;
  /** conservation.tv's own, in the cloud; otherwise one on site. */
  hosted: boolean;
}

export interface SignalSystem {
  channels: SignalChannel[];
  broadcasts: SignalBroadcast[];
  /** The first is the one everything is reached through, unless `routes` says otherwise. */
  gateways: SignalGateway[];
  networks: SignalNetwork[];
  /** Cameras, each on a network. */
  cameras: SignalSource[];
  /** Groups of cameras within a network, only to keep a long list in order. */
  subgroups: SignalSubgroup[];
  /** Pushed from anywhere; never grouped. */
  ingests: SignalSource[];
  /** The gateway a network is reached through, by the network's id, when it isn't the first. */
  routes: Record<string, string>;
}
