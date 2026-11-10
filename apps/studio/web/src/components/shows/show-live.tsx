import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { CloudSlashIcon } from '@phosphor-icons/react';
import type { System } from '@conservationtv/agent-sdk';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';

import { Fact, FactLabel, Facts, FactValue } from '@/components/common/page';
import { StatusLabel, type Status } from '@/components/common/status';
import type { ForwardPart } from '@/components/shows/show-detail';
import { useOrganisationId } from '@/hooks/use-organisation';
import { counted } from '@/lib/format';
import { agentSystemQueryOptions } from '@/queries/agent-system';

// What a show's output agent says about OBS right now, asked of the agent directly over iroh, as its own page asks
// (src/components/agents/agent-live.tsx): whether OBS runs and follows this show, whether it streams, and which of the
// show's channels the programme is being sent to. Nothing here comes from the studio API.

type ObsRuntime = System['obs']['runtime'];
type ObsPhase = NonNullable<ObsRuntime['phase']>;
type ProcessState = ObsRuntime['state'];

export interface ShowLiveProps {
  /** The output agent's device's public ID: its iroh endpoint ID. */
  publicId: string;
  /** The agent's name, for saying it can't be reached. */
  agentName: string;
  showId: string;
  forwards: ForwardPart[];
}

/** OBS on the show's output agent, asked again every few seconds; or why it couldn't be asked. Suspends once. */
export const ShowLive: FC<ShowLiveProps> = ({ publicId, agentName, showId, forwards }) => {
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
        <FactLabel>Following</FactLabel>
        <FactValue>{followingOf(obs, showId)}</FactValue>
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
          <FactValue>{counted(Object.keys(obs.program.cameras).length, 'source')}</FactValue>
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

/** Where OBS is with following the broadcast, in a few words. */
const phaseWords = {
  idle: 'Waiting',
  connecting: 'Connecting',
  'downloading-assets': 'Downloading assets',
  synchronising: 'Catching up',
  settled: 'The broadcast, live',
  disconnected: 'Disconnected',
  error: 'Failed',
  disposed: 'Stopped'
} satisfies Record<ObsPhase, string>;

/** Whether OBS follows this show, another, or none, and where it is with the broadcast. */
function followingOf(obs: ObsRuntime, showId: string): string {
  if (obs.show === null) return 'Nothing';
  if (obs.show !== showId) return 'Another show';
  return obs.phase ? phaseWords[obs.phase] : 'Starting';
}
