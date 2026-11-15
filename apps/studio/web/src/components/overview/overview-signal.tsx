import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';

import { Section, SectionDescription, SectionHeader, SectionHeading, SectionTitle } from '@/components/common/page';
import { Signal, SignalAttention, SignalCanvas, SignalHint } from '@/components/signal/signal';
import { useSignalLayout } from '@/components/signal/signal-context';
import { SignalMapView } from '@/components/signal/signal-map-view';
import { SignalStackView } from '@/components/signal/signal-stack-view';
import { useOrganisationId } from '@/hooks/use-organisation';
import { signalSystemQueryOptions } from '@/queries/topology';

// The organisation's signal on its overview: how it runs from the cameras, through the broadcast its shows follow, to
// the channels they go out to, as it stands. Read-only: the signal view with no editing composed on, so a press only
// follows a path or opens a network.

/** The map where there's room for it, the stack where there isn't. */
const View: FC = () => {
  const layout = useSignalLayout();
  return layout === 'map' ? <SignalMapView /> : <SignalStackView />;
};

/** Nothing, for an organisation with nothing to draw yet: its setup steps say what comes first. */
export const OverviewSignal: FC = () => {
  const organisationId = useOrganisationId();
  const { data: system } = useSuspenseQuery(signalSystemQueryOptions(organisationId));
  if (system.broadcasts.length + system.cameras.length + system.ingests.length === 0) return null;
  // The first network open to begin with, so its cameras are on show; any other opens on a press.
  const firstNetwork = system.networks.slice(0, 1).map(network => network.id);
  return (
    <Signal system={system} defaultOpen={firstNetwork}>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle className="flex items-center gap-2">
              Signal
              <SignalAttention />
            </SectionTitle>
            <SectionDescription>
              From the cameras, through the broadcast every show follows, to the channels each show goes out to.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <SignalCanvas className="flex-none p-0 lg:p-0">
          <View />
          <SignalHint>Press anything to follow its path; press a network to open it, one at a time.</SignalHint>
        </SignalCanvas>
      </Section>
    </Signal>
  );
};
