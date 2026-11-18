import type { FC } from 'react';
import {
  ArrowSquareInIcon,
  BroadcastIcon,
  BrowserIcon,
  CloudIcon,
  DesktopIcon,
  HardDrivesIcon,
  TiktokLogoIcon,
  TwitchLogoIcon,
  VideoCameraIcon,
  YoutubeLogoIcon
} from '@phosphor-icons/react';

import type { SignalGateway, SignalPlatform, SignalSource } from '@/components/signal/signal-system';

// The icons the signal view names its things by.

export interface PlatformIconProps {
  platform: SignalPlatform;
}

/** A channel's platform. */
export const PlatformIcon: FC<PlatformIconProps> = ({ platform }) => {
  if (platform === 'twitch') return <TwitchLogoIcon weight="fill" />;
  if (platform === 'youtube') return <YoutubeLogoIcon weight="fill" />;
  if (platform === 'rtmp') return <BroadcastIcon />;
  return <TiktokLogoIcon weight="fill" />;
};

export interface SourceIconProps {
  kind: SignalSource['kind'];
}

/** What kind of source: a camera, a desk running OBS, a member's browser, or something pushed over RTMP. */
export const SourceIcon: FC<SourceIconProps> = ({ kind }) => {
  if (kind === 'camera') return <VideoCameraIcon weight="fill" />;
  if (kind === 'obs') return <DesktopIcon />;
  if (kind === 'browser') return <BrowserIcon />;
  return <ArrowSquareInIcon />;
};

export interface GatewayIconProps {
  gateway: SignalGateway;
}

/** A gateway: conservation.tv's own in the cloud, or a machine on site. */
export const GatewayIcon: FC<GatewayIconProps> = ({ gateway }) => {
  return gateway.hosted ? <CloudIcon /> : <HardDrivesIcon />;
};
