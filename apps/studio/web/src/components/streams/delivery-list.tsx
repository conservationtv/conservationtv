import type { ComponentProps, FC, ReactNode } from 'react';
import { CloudIcon, GlobeIcon, HardDrivesIcon, NetworkIcon } from '@phosphor-icons/react';
import type { Rendition } from '@conservationtv/studio-sdk';
import { Badge } from '@conservationtv/ui/components/badge';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { cn } from '@conservationtv/ui/lib/utils';

import { StatusLabel } from '@/components/common/status';
import { RENDITIONS, renditionLabels } from '@/components/streams/renditions';
import type { Delivery, DeliverySection } from '@/components/streams/stream-detail';
import { statusLabels } from '@/components/streams/topology';

// A stream's deliveries as rows, composed where they're used: grouped by where they are (each network, then the
// internet) as the topology above them groups them, each row its gateway, what feeds it, who sends it, the renditions
// it offers and how it is doing, with whatever the page offers to do about it.
//
//   <DeliveryGroup>
//     <DeliveryGroupHeading section={section} />
//     <DeliveryRows>
//       <DeliveryRow delivery={delivery}>
//         <ItemActions>…</ItemActions>
//       </DeliveryRow>
//     </DeliveryRows>
//   </DeliveryGroup>

/** One network's deliveries, or the internet's, under its name. */
export const DeliveryGroup: FC<ComponentProps<'section'>> = ({ className, ...props }) => {
  return <section className={cn('flex flex-col gap-2', className)} {...props} />;
};

export interface DeliveryGroupHeadingProps {
  section: Pick<DeliverySection, 'networkId' | 'label'>;
}

export const DeliveryGroupHeading: FC<DeliveryGroupHeadingProps> = ({ section }) => {
  return (
    <h3 className="flex items-center gap-2 text-custom-13 text-foreground [&_svg]:size-4 [&_svg]:text-custom-icon-stream">
      {section.networkId === null ? <GlobeIcon aria-hidden="true" /> : <NetworkIcon aria-hidden="true" />}
      {section.label}
    </h3>
  );
};

/** The groups' rows, close together. */
export const DeliveryRows: FC<ComponentProps<typeof ItemGroup>> = ({ className, ...props }) => {
  return <ItemGroup className={cn('gap-2', className)} {...props} />;
};

/** A delivery's card: its DeliverySummary, then whatever the page adds (its actions, how to read it). */
export const DeliveryRow: FC<ComponentProps<typeof Item>> = props => {
  return <Item variant="outline" {...props} />;
};

export interface DeliverySummaryProps {
  delivery: Delivery;
  /** Anything more about it, under what feeds it: its Renditions, say. */
  children?: ReactNode;
}

/** A delivery's gateway and status, what feeds it and who sends it, with anything more beneath. */
export const DeliverySummary: FC<DeliverySummaryProps> = ({ delivery, children }) => {
  const internet = delivery.gateway?.networkId === null;
  return (
    <>
      <ItemMedia variant="icon">{internet ? <CloudIcon /> : <HardDrivesIcon />}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {delivery.name}
          <StatusLabel status={delivery.status}>{statusLabels[delivery.status]}</StatusLabel>
        </ItemTitle>
        <ItemDescription>
          Fed by {delivery.fedBy} ·{' '}
          {delivery.publisher ? `published by ${delivery.publisher}` : 'publisher chosen by the system'}
          {delivery.recorded && ' · has a recorder'}
        </ItemDescription>
        {children}
      </ItemContent>
    </>
  );
};

interface RenditionsProps {
  renditions: Rendition[];
}

/** The renditions offered, as quiet badges in their usual order. */
export const Renditions: FC<RenditionsProps> = ({ renditions }) => {
  return (
    <ul className="flex flex-wrap gap-1 pt-1" aria-label="Renditions">
      {RENDITIONS.filter(rendition => renditions.includes(rendition)).map(rendition => (
        <li key={rendition}>
          <Badge variant="outline">{renditionLabels[rendition]}</Badge>
        </li>
      ))}
    </ul>
  );
};
