import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { CaretDownIcon, CloudIcon, ShareNetworkIcon } from '@phosphor-icons/react';
import type { Device, Network, Stream } from '@conservationtv/studio-sdk';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@conservationtv/ui/components/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';

import type { Route } from './+types/gateways';
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { networkNameOf } from '@/components/devices/devices';
import { SubjectHealth } from '@/components/devices/subject-health';
import { deviceSubjectId, statesBySubject, type SubjectState } from '@/components/devices/subjects';
import { AddGatewayDialog, DeleteGatewayDialog, EditGatewayDialog } from '@/components/gateways/gateway-dialogs';
import { GatewayEndpoints } from '@/components/gateways/gateway-endpoints';
import { GatewayHostname } from '@/components/gateways/gateway-hostname';
import { gatewayKindLabelOf, gatewayOverridesOf, type ListedGateway } from '@/components/gateways/gateways';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { counted } from '@/lib/format';
import { deviceListQueryOptions } from '@/queries/devices';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { streamListQueryOptions, subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Gateways · conservation.tv studio' }];

/**
 * Where an organisation's streams are delivered: conservation.tv itself, built in and the same for everyone, then the
 * organisation's own MediaMTX servers, each run by the active agent on its network. Everyone reads them;
 * administrators add, change and remove the organisation's own.
 */
const GatewaysRoute: FC = () => {
  const organisationId = useOrganisationId();
  const administrator = useIsAdministrator();
  const [gatewaysQuery, networksQuery, streamsQuery, devicesQuery, statesQuery] = useSuspenseQueries({
    queries: [
      gatewayListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      streamListQueryOptions(organisationId),
      deviceListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  const builtin = gatewaysQuery.data.filter(gateway => gateway.builtin);
  const own = gatewaysQuery.data.filter(gateway => !gateway.builtin);
  const states = statesBySubject(statesQuery.data);
  const networks = networksQuery.data;
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Gateways</PageTitle>
          <PageDescription>
            Where your streams are delivered. conservation.tv carries them to viewers anywhere; a MediaMTX gateway on
            one of your networks serves them there, run by that network’s active agent.
          </PageDescription>
        </PageHeading>
        {administrator && (
          <PageActions>
            <AddGatewayDialog networks={networks} />
          </PageActions>
        )}
      </PageHeader>
      <ItemGroup className="gap-2">
        {builtin.map(gateway => (
          <BuiltinGatewayRow
            key={gateway.id}
            gateway={gateway}
            streamCount={streamCountOf(streamsQuery.data, gateway.id)}
          />
        ))}
      </ItemGroup>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Your gateways</SectionTitle>
            <SectionDescription>MediaMTX servers on your networks.</SectionDescription>
          </SectionHeading>
        </SectionHeader>
        {own.length > 0 ? (
          <ItemGroup className="gap-2">
            {own.map(gateway => {
              const runner = runnerOf(gateway, networks, devicesQuery.data);
              return (
                <GatewayRow
                  key={gateway.id}
                  gateway={gateway}
                  networks={networks}
                  streamCount={streamCountOf(streamsQuery.data, gateway.id)}
                  runner={runner}
                  runnerState={runner ? states.get(deviceSubjectId(runner.id)) : undefined}
                />
              );
            })}
          </ItemGroup>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShareNetworkIcon />
              </EmptyMedia>
              <EmptyTitle>No gateways of your own</EmptyTitle>
              <EmptyDescription>
                Add a MediaMTX gateway to serve streams on a network, for viewers and recorders there.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Section>
    </Page>
  );
};

export default GatewaysRoute;

/** How many streams are delivered to the gateway: those with an exposure on it. */
function streamCountOf(streams: Stream[], gatewayId: string): number {
  return streams.filter(stream => stream.exposures.some(exposure => exposure.gatewayId === gatewayId)).length;
}

/** The agent running the gateway: the active agent on its network, if it is on one and that has one. */
function runnerOf(gateway: ListedGateway, networks: Network[], devices: Device[]): Device | undefined {
  const network = networks.find(candidate => candidate.id === gateway.networkId);
  return devices.find(device => device.id === network?.activeAgent?.id);
}

interface BuiltinGatewayRowProps {
  gateway: ListedGateway;
  streamCount: number;
}

/** A built-in gateway: what it is and how many streams it carries. Nobody changes it. */
const BuiltinGatewayRow: FC<BuiltinGatewayRowProps> = ({ gateway, streamCount }) => {
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <CloudIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {gateway.name}
          <Badge variant="secondary">Built-in</Badge>
        </ItemTitle>
        <ItemDescription>
          {gatewayKindLabelOf(gateway.kind)} · Internet · {counted(streamCount, 'stream')}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="text-custom-12 text-custom-text-secondary">Read-only</span>
      </ItemActions>
    </Item>
  );
};

interface GatewayRowProps {
  gateway: ListedGateway;
  networks: Network[];
  streamCount: number;
  /** The agent running it, if any. */
  runner: Device | undefined;
  /** What agents last said about the agent running it. */
  runnerState: SubjectState | undefined;
}

/**
 * One of the organisation's gateways: where it is, how many streams it carries, the hostname it is reached at, and who
 * runs it. Where it is reachable right now, and what its settings override, open below it on demand.
 */
const GatewayRow: FC<GatewayRowProps> = ({ gateway, networks, streamCount, runner, runnerState }) => {
  const administrator = useIsAdministrator();
  return (
    <Collapsible render={<Item variant="outline" />}>
      <ItemMedia variant="icon">
        <ShareNetworkIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full">
          <span className="truncate">{gateway.name}</span>
        </ItemTitle>
        <ItemDescription>
          {gatewayKindLabelOf(gateway.kind)} · {networkNameOf(networks, gateway.networkId)} ·{' '}
          {counted(streamCount, 'stream')}
        </ItemDescription>
        {'tls' in gateway && <GatewayHostname tls={gateway.tls} />}
      </ItemContent>
      {administrator && (
        <ItemActions>
          <EditGatewayDialog gateway={gateway} networks={networks} />
          <DeleteGatewayDialog gateway={gateway} />
        </ItemActions>
      )}
      <ItemFooter className="gap-3 border-t border-border pt-2.5">
        <span className="flex min-w-0 items-center gap-3">
          <span className="text-custom-12 text-custom-text-secondary">Run by</span>
          {runner ? (
            <>
              <span className="truncate text-custom-12 text-foreground">{runner.name}</span>
              <SubjectHealth state={runnerState} />
            </>
          ) : (
            <span className="text-custom-12 text-custom-text-secondary">No active agent on its network</span>
          )}
        </span>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group/trigger" />}>
          Where it’s reachable
          <CaretDownIcon className="transition-transform group-data-panel-open/trigger:rotate-180" />
        </CollapsibleTrigger>
      </ItemFooter>
      <CollapsibleContent className="flex basis-full flex-col gap-4 pt-2">
        <GatewayEndpoints gatewayId={gateway.id} />
        <GatewayOverrides gateway={gateway} />
      </CollapsibleContent>
    </Collapsible>
  );
};

interface GatewayOverridesProps {
  gateway: ListedGateway;
}

/** The URLs the gateway's settings use in place of what its agent registers, if any. */
const GatewayOverrides: FC<GatewayOverridesProps> = ({ gateway }) => {
  const overrides = gatewayOverridesOf(gateway);
  if (overrides.length === 0) {
    return (
      <p className="text-custom-12 text-custom-text-secondary">No URL overrides: it uses what its agent registers.</p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-custom-12 text-custom-text-secondary">
        Its settings use these in place of what its agent registers:
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        {overrides.map(override => (
          <div key={override.protocol} className="contents">
            <dt className="text-custom-12 text-custom-text-secondary">{override.label}</dt>
            <dd className="truncate font-mono text-custom-12 text-foreground" title={override.url}>
              {override.url}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
};
