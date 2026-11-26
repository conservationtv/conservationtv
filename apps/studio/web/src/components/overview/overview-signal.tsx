import type { FC, ReactNode } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Topology } from '@conservationtv/studio-sdk';

import { Section, SectionDescription, SectionHeader, SectionHeading, SectionTitle } from '@/components/common/page';
import {
  Signal,
  SignalAttention,
  SignalCanvas,
  SignalHint,
  SignalNarrow,
  SignalThings,
  SignalWide
} from '@/components/signal/signal';
import { signalSystemOf } from '@/components/signal/signal-from-topology';
import { SignalMapView } from '@/components/signal/signal-map-view';
import { SignalStackView } from '@/components/signal/signal-stack-view';
import { useSignalHoverPreview } from '@/components/signal/signal-things';
import { subjectStatusesOf } from '@/components/streams/topology';
import { useOrganisationId } from '@/hooks/use-organisation';
import { organisationStatusQueryOptions } from '@/queries/organisations';
import { topologyQueryOptions } from '@/queries/topology';

// The organisation's signal on its overview: how it runs from the cameras, through the shows that place them and the
// outputs following those, to the channels the outputs go out to, as it stands. Read-only: the signal view with no editing composed on. Resting the
// pointer on a thing previews its path; pressing it opens its page; pressing a network opens it.

/** How long the pointer rests on a thing before its path is previewed, in milliseconds. */
const PREVIEW_AFTER = 800;

/**
 * Where each thing on the view has its page, under the organisation, by its id: a broadcast its output's; a channel the
 * output it's forwarded from (there's no page for a channel alone); a camera its own; any other source the first
 * stream from it.
 */
function pagesOf(topology: Topology): Map<string, string> {
  const outputs = topology.outputs.flatMap(output =>
    [output.id, ...output.forwards.map(forward => forward.id)].map(id => [id, `outputs/${output.id}`] as const)
  );
  const cameras = topology.devices
    .filter(device => device.kind === 'camera')
    .map(device => [device.id, `cameras/${device.id}`] as const);
  const ingests = topology.streams.flatMap(stream =>
    stream.sourceDeviceId ? [[stream.sourceDeviceId, `streams/${stream.id}`] as const] : []
  );
  // A later entry wins: a camera's own page over its streams', and an ingest's first stream over its others.
  return new Map([...ingests.toReversed(), ...cameras, ...outputs]);
}

/** The topology, and what each thing on the view links to. */
function pagesAndTopology(topology: Topology) {
  return { topology, pages: pagesOf(topology) };
}

/** Nothing, for an organisation with nothing to draw yet: its setup steps say what comes first. */
export const OverviewSignal: FC = () => {
  const organisationId = useOrganisationId();
  // What it links to is worked out once a refresh of the topology; how each thing is doing, from the organisation's
  // status, which refreshes itself.
  const [topologyQuery, statusQuery] = useSuspenseQueries({
    queries: [
      { ...topologyQueryOptions(organisationId), select: pagesAndTopology, refetchInterval: 30_000 },
      { ...organisationStatusQueryOptions(organisationId), select: subjectStatusesOf }
    ]
  });
  const { topology, pages } = topologyQuery.data;
  const system = signalSystemOf(topology, statusQuery.data);
  if (system.broadcasts.length + system.cameras.length + system.ingests.length === 0) return null;
  // The first network open to begin with, so its cameras are on show; any other opens on a press.
  const firstNetwork = system.networks.slice(0, 1).map(network => network.id);
  return (
    <Signal system={system} defaultOpen={firstNetwork}>
      <OverviewSignalLinks pages={pages}>
        <Section>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle className="flex items-center gap-2">
                Signal
                <SignalAttention />
              </SectionTitle>
              <SectionDescription>
                From the cameras, through the shows that place them and the outputs following those, to the channels
                each output goes out to.
              </SectionDescription>
            </SectionHeading>
          </SectionHeader>
          <SignalCanvas className="flex-none p-0 lg:p-0">
            {/* The map where the section has room for it, the stack where it hasn't: by its own width, not the window's. */}
            <SignalWide>
              <SignalMapView />
            </SignalWide>
            <SignalNarrow>
              <SignalStackView />
            </SignalNarrow>
            <SignalHint>
              Rest on anything to follow its path, press it to open its page; press a network to open it.
            </SignalHint>
          </SignalCanvas>
        </Section>
      </OverviewSignalLinks>
    </Signal>
  );
};

interface OverviewSignalLinksProps {
  /** Each thing's page, under the organisation, by its id. */
  pages: Map<string, string>;
  children: ReactNode;
}

/**
 * What the overview's things do: resting on one previews its path, and pressing one opens its page (in a new tab, with
 * the platform's modifier). A thing with no page only previews.
 */
const OverviewSignalLinks: FC<OverviewSignalLinksProps> = ({ pages, children }) => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const preview = useSignalHoverPreview(PREVIEW_AFTER);
  return (
    <SignalThings
      props={thing => {
        const page = pages.get(thing.id);
        if (page === undefined) return preview(thing);
        const href = `/organisations/${organisationId}/${page}`;
        return {
          ...preview(thing),
          role: 'link',
          onClick: event => {
            if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener');
            else void navigate(href);
          }
        };
      }}
    >
      {children}
    </SignalThings>
  );
};
