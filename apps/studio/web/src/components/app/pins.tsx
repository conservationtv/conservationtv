import type { FC, ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
  FileIcon,
  HardDrivesIcon,
  MonitorPlayIcon,
  NetworkIcon,
  PushPinSimpleIcon,
  VideoCameraIcon,
  VideoIcon
} from '@phosphor-icons/react';
import { useLocation } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';

import type { PinKind } from '@/lib/pins';
import { pinListQueryOptions, useTogglePin } from '@/queries/this-device';

const kindIcons = {
  stream: <VideoIcon aria-hidden="true" />,
  show: <MonitorPlayIcon aria-hidden="true" />,
  camera: <VideoCameraIcon aria-hidden="true" />,
  agent: <HardDrivesIcon aria-hidden="true" />,
  network: <NetworkIcon aria-hidden="true" />,
  page: <FileIcon aria-hidden="true" />
} satisfies Record<PinKind, ReactNode>;

export interface PinIconProps {
  kind: PinKind;
}

/** The icon a pinned page goes by on the rail: what it is about. */
export const PinIcon: FC<PinIconProps> = ({ kind }) => {
  return kindIcons[kind];
};

export interface PinButtonProps {
  /** What the pin is called on the rail: the page's own name. */
  label: string;
  kind: PinKind;
}

/**
 * Pins the page it is on to the app's rail, or unpins it: a page's top-right corner, as a detail page's header action.
 * The pin is the page's path and the name it had when pinned; the name doesn't follow a later rename.
 */
export const PinButton: FC<PinButtonProps> = ({ label, kind }) => {
  const location = useLocation();
  const pinsQuery = useSuspenseQuery(pinListQueryOptions());
  const toggle = useTogglePin();
  const pinned = pinsQuery.data.some(pin => pin.to === location.pathname);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
            onClick={() => toggle.mutate({ to: location.pathname, label, kind })}
          />
        }
      >
        <PushPinSimpleIcon weight={pinned ? 'fill' : 'regular'} />
      </TooltipTrigger>
      <TooltipContent>{pinned ? 'Unpin from the rail' : 'Pin to the rail'}</TooltipContent>
    </Tooltip>
  );
};
