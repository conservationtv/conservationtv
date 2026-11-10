import type { FC, ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { CloudSlashIcon } from '@phosphor-icons/react';
import type { System } from '@conservationtv/agent-sdk';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from '@conservationtv/ui/components/item';

import { Fact, FactLabel, Facts, FactValue } from '@/components/common/page';
import { StatusLabel, type Status } from '@/components/common/status';
import { useOrganisationId } from '@/hooks/use-organisation';
import { formatBytes, formatDuration, formatRelative } from '@/lib/format';
import { agentSystemQueryOptions } from '@/queries/agent-system';

// What an agent says about itself right now, asked of the agent directly over iroh (src/lib/agent-connection.ts):
// the machine it is on, and each of its runtimes. Nothing here comes from the studio API, so it is as fresh as the
// last few seconds, and it is there even when the agent can't reach the studio to report.

export interface AgentLiveProps {
  /** The agent's device's public ID: its iroh endpoint ID. */
  publicId: string;
}

/** The agent's machine and runtimes, asked again every few seconds; or why it couldn't be asked. Suspends once. */
export const AgentLive: FC<AgentLiveProps> = ({ publicId }) => {
  const organisationId = useOrganisationId();
  const liveQuery = useSuspenseQuery(agentSystemQueryOptions(organisationId, publicId));
  const live = liveQuery.data;
  if ('failure' in live) {
    return (
      <Alert>
        <CloudSlashIcon />
        <AlertTitle>Can’t reach this agent</AlertTitle>
        <AlertDescription>
          {live.failure} Trying again shortly. What it last reported to the studio is still shown above.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Machine machine={live.system.machine.runtime.latest} />
      <ItemGroup className="gap-2">
        <MediamtxRuntime streams={live.system.streams} />
        <ObsRuntime obs={live.system.obs} />
        <MetricsRuntime metrics={live.system.metrics} />
      </ItemGroup>
    </div>
  );
};

type MachineSample = System['machine']['runtime']['latest'];

interface MachineProps {
  machine: MachineSample;
}

/** A percentage of a total that is in use, given what is free: "62%". */
function usedShare(total: number, free: number): string {
  return `${Math.round(((total - free) / total) * 100)}%`;
}

/** The machine the agent runs on, as it last sampled it. */
const Machine: FC<MachineProps> = ({ machine }) => {
  if (!machine)
    return <p className="text-custom-13 text-muted-foreground">The agent hasn’t sampled its machine yet.</p>;
  const address = machine.addresses.find(candidate => candidate.preferred) ?? machine.addresses[0];
  return (
    <Facts>
      <Fact>
        <FactLabel>Processor</FactLabel>
        <FactValue>
          {machine.cpuUtilisation === null ? 'Measuring' : `${Math.round(machine.cpuUtilisation)}%`} of{' '}
          {machine.cpuCount} cores
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Load</FactLabel>
        <FactValue>{machine.load.toFixed(2)}</FactValue>
      </Fact>
      <Fact>
        <FactLabel>Memory</FactLabel>
        <FactValue>
          {usedShare(machine.memory.total, machine.memory.free)} of {formatBytes(machine.memory.total)}
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Disk</FactLabel>
        <FactValue>
          {machine.disk
            ? `${usedShare(machine.disk.total, machine.disk.free)} of ${formatBytes(machine.disk.total)}`
            : 'Unknown'}
        </FactValue>
      </Fact>
      <Fact>
        <FactLabel>Up for</FactLabel>
        <FactValue>{formatDuration(machine.uptimeSeconds)}</FactValue>
      </Fact>
      <Fact>
        <FactLabel>Agent memory</FactLabel>
        <FactValue>{formatBytes(machine.agentRss)}</FactValue>
      </Fact>
      <Fact>
        <FactLabel>Address</FactLabel>
        <FactValue>{address ? `${address.address} (${address.interface})` : 'None found'}</FactValue>
      </Fact>
    </Facts>
  );
};

/** How a process the agent runs is doing, as its status. */
const processStatuses = {
  running: 'ok',
  starting: 'unknown',
  stopped: 'unknown',
  crashed: 'failing'
} satisfies Record<System['streams']['runtime']['state'], Status>;

const processWords = {
  running: 'Running',
  starting: 'Starting',
  stopped: 'Stopped',
  crashed: 'Crashed'
} satisfies Record<System['streams']['runtime']['state'], string>;

type Apply = System['streams']['apply'];

interface RuntimeRowProps {
  /** The runtime's name, then anything beside it. */
  title: ReactNode;
  /** What it is doing, in a line. */
  children: ReactNode;
  status: Status;
  /** The status in a word. */
  word: string;
  apply: Apply;
  /** The runtime's own last error, if it has one. */
  error: string | null;
}

/** One of the agent's runtimes: what it is, how it is, and whether it has taken its latest configuration. */
const RuntimeRow: FC<RuntimeRowProps> = ({ title, children, status, word, apply, error }) => {
  const failure =
    apply.state === 'failed' ? `Couldn’t apply its configuration (attempt ${apply.attempt}): ${apply.error}` : error;
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{children}</ItemDescription>
        {failure && <p className="text-custom-12 text-destructive">{failure}</p>}
      </ItemContent>
      <ItemActions>
        <StatusLabel status={apply.state === 'failed' ? 'failing' : status}>
          {apply.state === 'applying' ? 'Applying configuration' : word}
        </StatusLabel>
      </ItemActions>
    </Item>
  );
};

interface MediamtxRuntimeProps {
  streams: System['streams'];
}

/** MediaMTX, which the agent runs to pull from cameras and serve their streams on the network. */
const MediamtxRuntime: FC<MediamtxRuntimeProps> = ({ streams }) => {
  const { runtime, apply } = streams;
  return (
    <RuntimeRow
      title="MediaMTX"
      status={processStatuses[runtime.state]}
      word={runtime.installing ? 'Installing' : processWords[runtime.state]}
      apply={apply}
      error={runtime.lastError}
    >
      {runtime.servingVersion ?? runtime.version ?? 'No version yet'}
      {runtime.pid === null ? null : ` · process ${runtime.pid}`}
      {runtime.restarts > 0 ? ` · restarted ${runtime.restarts} times` : null}
    </RuntimeRow>
  );
};

interface ObsRuntimeProps {
  obs: System['obs'];
}

/** OBS, which an agent that sends a show out runs; a line saying it isn't in use on one that doesn't. */
const ObsRuntime: FC<ObsRuntimeProps> = ({ obs }) => {
  const { runtime, apply } = obs;
  const idle = runtime.show === null && runtime.state === 'stopped';
  return (
    <RuntimeRow
      title="OBS"
      status={processStatuses[runtime.state]}
      word={idle ? 'Not in use' : runtime.installing ? 'Installing' : processWords[runtime.state]}
      apply={apply}
      error={runtime.lastError}
    >
      {idle ? 'This agent isn’t a show’s output.' : (runtime.version ?? 'No version yet')}
      {runtime.streaming ? ` · ${runtime.streaming}` : null}
      {runtime.program ? ` · forwarding to ${runtime.program.forwards.length} channels` : null}
    </RuntimeRow>
  );
};

interface MetricsRuntimeProps {
  metrics: System['metrics'];
}

/** The agent's reporting to the studio: the measurements it takes of its streams and sends on. */
const MetricsRuntime: FC<MetricsRuntimeProps> = ({ metrics }) => {
  const { runtime, apply } = metrics;
  return (
    <RuntimeRow
      title="Reporting"
      status={runtime.running ? 'ok' : 'unknown'}
      word={runtime.running ? 'Running' : 'Stopped'}
      apply={apply}
      error={runtime.lastError}
    >
      {runtime.lastSubmittedAt
        ? `Last sent to the studio ${formatRelative(runtime.lastSubmittedAt)}`
        : 'Nothing sent yet'}
      {runtime.pending > 0 ? ` · ${runtime.pending} waiting to send` : null}
    </RuntimeRow>
  );
};
