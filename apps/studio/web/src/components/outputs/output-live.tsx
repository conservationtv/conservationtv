import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { CloudSlashIcon } from '@phosphor-icons/react';
import type { System } from '@conservationtv/agent-sdk';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';

import { Fact, FactLabel, Facts, FactValue } from '@/components/common/page';
import { StatusLabel, type Status } from '@/components/common/status';
import type { ForwardPart } from '@/components/outputs/output-detail';
import { useOrganisationId } from '@/hooks/use-organisation';
import { counted } from '@/lib/format';
import { agentSystemQueryOptions } from '@/queries/agent-system';

// What an output's agent says about OBS right now, asked of the agent directly over iroh, as its own page asks
// (src/components/agents/agent-live.tsx): whether OBS runs this output, what drives its scenes (the show it follows,
// and how far it has caught up, or something outside the studio), whether it streams, and which of the output's
// channels the programme is being sent to. Nothing here comes from the studio API.

type ObsRuntime = System['obs']['runtime'];
type ShowRuntime = System['show']['runtime'];
type ShowPhase = NonNullable<ShowRuntime['phase']>;
type ProcessState = ObsRuntime['state'];

export interface OutputLiveProps {
  /** The agent's device's public ID: its iroh endpoint ID. */
  publicId: string;
  /** The agent's name, for saying it can't be reached. */
  agentName: string;
  outputId: string;
  /** The show the output follows, if any: what the agent's `show` key should be following. */
  showId: string | null;
  forwards: ForwardPart[];
}

/** OBS on the output's agent, asked again every few seconds; or why it couldn't be asked. Suspends once. */
export const OutputLive: FC<OutputLiveProps> = ({ publicId, agentName, outputId, showId, forwards }) => {
  const organisationId = useOrganisationId();
  const liveQuery = useSuspenseQuery(agentSystemQueryOptions(organisationId, publicId));
  const live = liveQuery.data;
  if ('failure' in live) {
    return (
      <Alert>
        <CloudSlashIcon />
        <AlertTitle>Can’t reach {agentName}</AlertTitle>
        <AlertDescription>{live.failure} Trying again shortly.</AlertDescription>
      </Alert>
    );
  }
  const obs = live.system.obs.runtime;
  const show = live.system.show.runtime;
  const sending = forwards.filter(part => obs.program?.forwards.includes(part.forward.channelId));
  return (
    <Facts>
      <Fact>
        <FactLabel>OBS</FactLabel>
        <FactValue>
          <StatusLabel status={processStatuses[obs.state]} className="text-custom-13 text-foreground">
            {obs.installing ? 'Installing' : processWords[obs.state]}
            {obs.version ? ` · ${obs.version}` : null}
          </StatusLabel>
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Scenes</FactLabel>
        <FactValue>{drivenByOf(obs, show, outputId, showId)}</FactValue>
      </Fact>
      <Fact>
        <FactLabel>Streaming</FactLabel>
        <FactValue>
          <StatusLabel
            status={obs.streaming === 'streaming' ? 'ok' : 'unknown'}
            className="text-custom-13 text-foreground"
          >
            {obs.streaming ? streamingWords[obs.streaming] : 'Not streaming'}
          </StatusLabel>
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Sending to</FactLabel>
        <FactValue className="whitespace-normal">
          {sending.length > 0 ? sending.map(part => part.name).join(', ') : 'No channel'}
        </FactValue>
      </Fact>
      {obs.program && (
        <Fact>
          <FactLabel>In the programme</FactLabel>
          <FactValue>{counted(Object.keys(obs.program.inputs).length, 'source')}</FactValue>
        </Fact>
      )}
    </Facts>
  );
};

const processWords = {
  running: 'Running',
  starting: 'Starting',
  stopped: 'Stopped',
  crashed: 'Crashed'
} satisfies Record<ProcessState, string>;

const processStatuses = {
  running: 'ok',
  starting: 'unknown',
  stopped: 'unknown',
  crashed: 'failing'
} satisfies Record<ProcessState, Status>;

const streamingWords = {
  starting: 'Starting',
  streaming: 'Streaming',
  reconnecting: 'Reconnecting'
} satisfies Record<NonNullable<ObsRuntime['streaming']>, string>;

/** Where OBS is with following the show, in a few words. */
const phaseWords = {
  idle: 'Waiting',
  connecting: 'Connecting',
  'downloading-assets': 'Downloading assets',
  synchronising: 'Catching up',
  settled: 'The show, live',
  disconnected: 'Disconnected',
  error: 'Failed',
  disposed: 'Stopped'
} satisfies Record<ShowPhase, string>;

/**
 * What drives OBS's scenes, as the agent has it: nothing while it runs another output or none; something outside the
 * studio, on its own scene collection; or the show it follows, and where it is with it.
 */
function drivenByOf(obs: ObsRuntime, show: ShowRuntime, outputId: string, showId: string | null): string {
  if (obs.output !== outputId) return obs.output === null ? 'Not running this output' : 'Another output';
  if (obs.control === 'external') return obs.collection ? `From outside · ${obs.collection}` : 'From outside';
  if (show.show === null) return showId === null ? 'No show' : 'Starting';
  if (show.show !== showId) return 'Another show';
  return show.phase ? phaseWords[show.phase] : 'Starting';
}
