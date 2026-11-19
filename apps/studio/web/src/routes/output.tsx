import { Suspense, type FC, type ReactNode } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import {
  BroadcastIcon,
  CloudIcon,
  FilmStripIcon,
  HardDrivesIcon,
  MonitorPlayIcon,
  NetworkIcon,
  PlayIcon,
  PlugsConnectedIcon,
  RecordIcon,
  ScreencastIcon,
  TwitchLogoIcon,
  XIcon
} from '@phosphor-icons/react';
import type { Agent, Channel, Output, Show } from '@conservationtv/studio-sdk';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { Button } from '@conservationtv/ui/components/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from '@conservationtv/ui/components/item';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tabs, TabsContent } from '@conservationtv/ui/components/tabs';
import { Link } from 'react-router';
import { parseAsBoolean, useQueryState } from 'nuqs';

import type { Route } from './+types/output';
import { PinButton } from '@/components/app/pins';
import { ChannelPlatformState } from '@/components/channels/platform-state';
import {
  BackLink,
  Fact,
  FactLabel,
  Facts,
  FactValue,
  Page,
  PageActions,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle
} from '@/components/common/page';
import { StatusLabel } from '@/components/common/status';
import { gatewayNameOf, type ListedGateway } from '@/components/gateways/gateways';
import { ControlDialog, OutputControlDetails, ShowSelect } from '@/components/outputs/output-control';
import {
  outputDetailOf,
  type ForwardPart,
  type OutputDetail,
  type PreviewPart
} from '@/components/outputs/output-detail';
import {
  ClearDeviceDialog,
  DeleteOutputDialog,
  DeviceSelect,
  EncodingDialog,
  RenameOutputDialog
} from '@/components/outputs/output-dialogs';
import { OutputLive } from '@/components/outputs/output-live';
import {
  AddForwardMenu,
  AddPreviewMenu,
  ForwardSwitch,
  RecorderSwitch,
  RemoveForwardDialog,
  RemovePreviewDialog
} from '@/components/outputs/output-parts';
import { OutputTraffic } from '@/components/outputs/output-traffic';
import {
  PageTabsActionLabel,
  PageTabsActions,
  PageTabsBar,
  PageTabsList,
  PageTabsTrigger
} from '@/components/common/page-tabs';
import { BroadcastStage } from '@/components/shows/broadcast-stage';
import { DeliveryRow } from '@/components/streams/delivery-list';
import { LocalRead } from '@/components/streams/local-read';
import { MoqRead } from '@/components/streams/output-read';
import { CONSERVATIONTV_GATEWAY } from '@/components/streams/renditions';
import { TopologyDiagram } from '@/components/streams/stream-topology';
import { statusLabels } from '@/components/streams/topology';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { useTabsQuery } from '@/hooks/use-tabs-query';
import { formatDate } from '@/lib/format';
import { agentListQueryOptions } from '@/queries/agents';
import { channelListQueryOptions } from '@/queries/channels';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { outputListQueryOptions, previewMoqReadQueryOptions, previewReadQueryOptions } from '@/queries/outputs';
import { showListQueryOptions } from '@/queries/shows';
import { subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Output · conservation.tv studio' }];

/**
 * One output, laid out as a stream's page is: what drives its scenes, how it goes out (its agent, its programme, the
 * channels it is forwarded to and the gateways it is previewed at), how to read its previews, its recording, and its
 * traffic, with the show it follows a button away. Everyone reads it; administrators change it.
 */
const OutputRoute: FC<Route.ComponentProps> = ({ params }) => {
  return (
    <Page className="max-w-5xl gap-6">
      <BackLink to=".." relative="path">
        Outputs
      </BackLink>
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <OutputView key={params.outputId} outputId={params.outputId} />
      </Suspense>
    </Page>
  );
};

export default OutputRoute;

interface OutputViewProps {
  outputId: string;
}

/** The output and everything it names, read at once from the organisation's lists, then laid out in render. */
const OutputView: FC<OutputViewProps> = ({ outputId }) => {
  const organisationId = useOrganisationId();
  const [outputsQuery, showsQuery, agentsQuery, channelsQuery, gatewaysQuery, networksQuery, statesQuery] =
    useSuspenseQueries({
      queries: [
        {
          ...outputListQueryOptions(organisationId),
          // This output, and the others, whose agents it can't also run on.
          select: (outputs: Output[]) => ({ output: outputs.find(output => output.id === outputId), outputs })
        },
        showListQueryOptions(organisationId),
        agentListQueryOptions(organisationId),
        channelListQueryOptions(organisationId),
        gatewayListQueryOptions(organisationId),
        networkListQueryOptions(organisationId),
        subjectStateListQueryOptions(organisationId)
      ]
    });
  const { output, outputs } = outputsQuery.data;
  if (!output) return <OutputNotFound />;
  const detail = outputDetailOf({
    output,
    shows: showsQuery.data,
    agents: agentsQuery.data,
    channels: channelsQuery.data.channels,
    gateways: gatewaysQuery.data,
    networks: networksQuery.data,
    states: statesQuery.data
  });
  const choices: OutputChoices = {
    outputs,
    shows: showsQuery.data,
    agents: agentsQuery.data,
    channels: channelsQuery.data.channels,
    gateways: gatewaysQuery.data
  };
  return (
    <>
      <PageHeader className="items-center">
        <PageHeading className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <PageTitle className="min-w-0 truncate">{output.name}</PageTitle>
          <StatusLabel status={detail.liveness.status} className="text-custom-13">
            {detail.liveness.label}
          </StatusLabel>
        </PageHeading>
        <PageActions>
          <PinButton label={output.name} kind="output" />
        </PageActions>
      </PageHeader>
      <OutputTabs detail={detail} choices={choices} />
    </>
  );
};

/** An ID that names no output of this organisation: deleted, or never one. */
const OutputNotFound: FC = () => {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ScreencastIcon />
        </EmptyMedia>
        <EmptyTitle>Output not found</EmptyTitle>
        <EmptyDescription>It may have been deleted, or it belongs to another organisation.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/** What the output's controls choose among: the organisation's outputs, shows, agents, channels and gateways. */
interface OutputChoices {
  outputs: Output[];
  shows: Show[];
  agents: Agent[];
  channels: Channel[];
  gateways: ListedGateway[];
}

interface OutputTabsProps {
  detail: OutputDetail;
  choices: OutputChoices;
}

/** Whether the show is open, as `?watch=true` in its address, so a link can open the output playing. */
const watchParser = parseAsBoolean.withDefault(false);

/**
 * Configuration, previews, recording and traffic, under line tabs, with the show it follows a button away at the row's
 * end.
 */
const OutputTabs: FC<OutputTabsProps> = ({ detail, choices }) => {
  const { show } = detail;
  const tabs = useTabsQuery('tab', ['configuration', 'previews', 'recording', 'traffic']);
  const [watching, setWatching] = useQueryState('watch', watchParser);
  return (
    <Tabs {...tabs} className="gap-8">
      <PageTabsBar>
        <PageTabsList>
          <PageTabsTrigger value="configuration">Configuration</PageTabsTrigger>
          <PageTabsTrigger value="previews">
            Previews
            {detail.previews.length > 0 && (
              <span className="text-muted-foreground tabular-nums">{detail.previews.length}</span>
            )}
          </PageTabsTrigger>
          <PageTabsTrigger value="recording">Recording</PageTabsTrigger>
          <PageTabsTrigger value="traffic">Traffic</PageTabsTrigger>
        </PageTabsList>
        {show && (
          <PageTabsActions>
            <Button variant="ghost" size="sm" aria-pressed={watching} onClick={() => setWatching(!watching)}>
              {watching ? <XIcon /> : <PlayIcon />}
              <PageTabsActionLabel>{watching ? 'Close show' : 'Watch show'}</PageTabsActionLabel>
            </Button>
          </PageTabsActions>
        )}
      </PageTabsBar>
      {show && watching && (
        <div
          ref={element => element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
          className="flex w-full max-w-3xl flex-col gap-2 self-center"
        >
          {/* Another show is another stream, so the stage starts over. */}
          <BroadcastStage key={show.id} showId={show.id} />
          <p className="text-custom-12 text-muted-foreground">
            {show.name}, which this output follows: what it sends out, as its channels see it.
          </p>
        </div>
      )}
      <TabsContent value="configuration" className="flex flex-col gap-12">
        <ConfigurationPanel detail={detail} choices={choices} />
      </TabsContent>
      <TabsContent value="previews">
        <PreviewsPanel detail={detail} />
      </TabsContent>
      <TabsContent value="recording">
        <RecordingPanel detail={detail} />
      </TabsContent>
      <TabsContent value="traffic">
        <Suspense fallback={<Skeleton className="h-52 w-full" />}>
          <OutputTraffic detail={detail} />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
};

/** What OBS is doing on the agent now, its way out drawn and as rows to change, and deleting it. */
const ConfigurationPanel: FC<OutputTabsProps> = ({ detail, choices }) => {
  const administrator = useIsAdministrator();
  const { output } = detail;
  return (
    <>
      <OutputFacts output={output} />
      <RightNow detail={detail} />
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Going out</SectionTitle>
            <SectionDescription>
              What drives its scenes, the agent that runs OBS for it, the programme OBS encodes, and the channels and
              previews it goes to.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <div className="rounded-xl border border-border p-5">
          {detail.topology.nodes.length > 0 ? (
            <TopologyDiagram topology={detail.topology} statuses={detail.statuses} />
          ) : (
            <p className="text-custom-13 text-muted-foreground">
              Nothing sends it out until it has an agent: choose one below.
            </p>
          )}
        </div>
        <ItemGroup className="gap-2">
          <DriverRow detail={detail} shows={choices.shows} />
          <AgentRow detail={detail} choices={choices} />
          <ProgrammeRow detail={detail} />
          <RecorderRow detail={detail} />
        </ItemGroup>
      </Section>
      {administrator && output.control === 'external' && <ControlSection detail={detail} />}
      <ChannelsSection detail={detail} channels={choices.channels} />
      <PreviewsSection detail={detail} gateways={choices.gateways} />
      {administrator && (
        <Section className="border-t border-border pt-8">
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Delete this output</SectionTitle>
              <SectionDescription>
                It stops going out, and its forwards, previews and recorder go with it. Channels and shows stay.
              </SectionDescription>
            </SectionHeading>
            <DeleteOutputDialog output={output} />
          </SectionHeader>
        </Section>
      )}
    </>
  );
};

interface OutputFactsProps {
  output: Output;
}

/** The output's name, with renaming it for administrators, and when it was made. */
const OutputFacts: FC<OutputFactsProps> = ({ output }) => {
  const administrator = useIsAdministrator();
  return (
    <Section>
      <Facts>
        <Fact>
          <FactLabel>Name</FactLabel>
          <FactValue className="flex items-center gap-1">
            <span className="truncate">{output.name}</span>
            {administrator && <RenameOutputDialog output={output} />}
          </FactValue>
        </Fact>
        <Fact>
          <FactLabel>Created</FactLabel>
          <FactValue>{formatDate(output.createdAt)}</FactValue>
        </Fact>
      </Facts>
    </Section>
  );
};

/**
 * What OBS on the agent says it is doing, asked of the agent, in its own boundary so an agent that is off doesn't hold
 * the page. Nothing while the output has no agent the organisation still lists.
 */
const RightNow: FC<RowProps> = ({ detail }) => {
  const { agent, output } = detail;
  const publicId = agent?.agent?.device?.publicId;
  if (!agent || !publicId) return null;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Right now</SectionTitle>
          <SectionDescription>Asked of {agent.name} itself, from this browser, every few seconds.</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <Suspense fallback={<Skeleton className="h-12 w-full" />}>
        <OutputLive
          publicId={publicId}
          agentName={agent.name}
          outputId={output.id}
          showId={output.showId}
          forwards={detail.forwards}
        />
      </Suspense>
    </Section>
  );
};

/**
 * How something outside the studio drives OBS, for administrators of an output under `external` control: obs-websocket
 * on the agent, the scene collection it runs, and where OBS reads the organisation's streams. Nothing to read until the
 * output has an agent, which reports it.
 */
const ControlSection: FC<RowProps> = ({ detail }) => {
  const { agent, output } = detail;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Driving it from outside</SectionTitle>
          <SectionDescription>
            Whatever drives it (a script, a vision mixer, a control surface) connects to obs-websocket on the agent’s
            network and switches the scenes in the scene collection below. To play one of the organisation’s streams in
            OBS, add a media source reading the stream input, with the stream’s and its delivery’s IDs in place of
            <code>{'{streamId}'}</code> and <code>{'{exposureId}'}</code>, and its reconnect delay set to 1 second: the
            first time a stream is read, OBS is dropped from it once as it is set up, and OBS’s default delay leaves it
            blank for 10 seconds. The studio still keeps OBS running, streaming, forwarded, previewed and recorded.
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>
      {agent ? (
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <OutputControlDetails output={output} deviceId={agent.deviceId} />
        </Suspense>
      ) : (
        <p className="text-custom-13 text-muted-foreground">
          Choose the agent it runs on first: that agent reports how to reach its OBS.
        </p>
      )}
    </Section>
  );
};

interface ChannelsSectionProps {
  detail: OutputDetail;
  channels: Channel[];
}

/** The channels the output is forwarded to, each on or off, and for administrators, adding another. */
const ChannelsSection: FC<ChannelsSectionProps> = ({ detail, channels }) => {
  const administrator = useIsAdministrator();
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Channels</SectionTitle>
          <SectionDescription>
            Where the output sends the programme. A channel that is off stays the output’s, but isn’t sent anything.
          </SectionDescription>
        </SectionHeading>
        {administrator && <AddForwardMenu output={detail.output} channels={channels} />}
      </SectionHeader>
      {detail.forwards.length > 0 ? (
        <ItemGroup className="gap-2">
          {detail.forwards.map(part => (
            <ForwardRow key={part.forward.id} outputId={detail.output.id} part={part} />
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Not sent to any channel</EmptyTitle>
            <EmptyDescription>
              Add one of the organisation’s channels for the programme to go out to it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );
};

interface PreviewsSectionProps {
  detail: OutputDetail;
  gateways: ListedGateway[];
}

/** The gateways the output is previewed at, and for administrators, adding or removing one. */
const PreviewsSection: FC<PreviewsSectionProps> = ({ detail, gateways }) => {
  const administrator = useIsAdministrator();
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Previews</SectionTitle>
          <SectionDescription>
            Gateways the output publishes the programme to, for the organisation to watch it there: at conservation.tv
            from anywhere, or at a gateway on a network from that network.
          </SectionDescription>
        </SectionHeading>
        {administrator && <AddPreviewMenu output={detail.output} gateways={gateways} />}
      </SectionHeader>
      {detail.previews.length > 0 ? (
        <ItemGroup className="gap-2">
          {detail.previews.map(part => (
            <DeliveryRow key={part.preview.id}>
              <PreviewSummary part={part} agent={detail.agent?.name} />
              {administrator && (
                <ItemActions>
                  <RemovePreviewDialog outputId={detail.output.id} part={part} />
                </ItemActions>
              )}
            </DeliveryRow>
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Not previewed anywhere</EmptyTitle>
            <EmptyDescription>
              Add a preview at conservation.tv to watch the programme as it goes out, from anywhere.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );
};

interface RowProps {
  detail: OutputDetail;
}

interface DriverRowProps extends RowProps {
  shows: Show[];
}

/**
 * What drives the output's scenes: the show it follows, opening its page, or none; or something outside the studio.
 * For administrators, choosing the show, and switching between the two.
 */
const DriverRow: FC<DriverRowProps> = ({ detail, shows }) => {
  const administrator = useIsAdministrator();
  const { output, show } = detail;
  const external = output.control === 'external';
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">{external ? <PlugsConnectedIcon /> : <MonitorPlayIcon />}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {external ? (
            'Driven from outside the studio'
          ) : show ? (
            <Link to={`../../shows/${show.id}`} relative="path" className="underline-offset-2 hover:underline">
              {show.name}
            </Link>
          ) : (
            'No show'
          )}
        </ItemTitle>
        <ItemDescription>
          {external
            ? 'Something outside the studio switches OBS’s scenes over obs-websocket, and may read any of the organisation’s streams.'
            : show
              ? 'The show it follows drives OBS’s scenes: what is on screen is the show’s.'
              : 'It follows no show, so nothing drives OBS’s scenes and it reads no streams. Choose a show to follow.'}
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          {!external && <ShowSelect output={output} shows={shows} />}
          <ControlDialog output={output} />
        </ItemActions>
      )}
    </Item>
  );
};

interface AgentRowProps extends RowProps {
  choices: OutputChoices;
}

/** The agent that runs the output's OBS, how it is doing, and for administrators, choosing or clearing it. */
const AgentRow: FC<AgentRowProps> = ({ detail, choices }) => {
  const administrator = useIsAdministrator();
  const { agent, output } = detail;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <HardDrivesIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {agent ? agent.name : 'No agent'}
          {agent && <StatusLabel status={agent.status}>{statusLabels[agent.status]}</StatusLabel>}
        </ItemTitle>
        <ItemDescription>
          {agent
            ? 'Runs OBS for the output: it encodes the programme and sends it out.'
            : 'An agent on Windows or macOS runs OBS for the output. Until one is chosen, nothing sends it out.'}
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          <DeviceSelect output={output} agents={choices.agents} outputs={choices.outputs} />
          {agent && <ClearDeviceDialog output={output} />}
        </ItemActions>
      )}
    </Item>
  );
};

/** The programme OBS encodes, how it is doing, and for administrators, changing its encoding. */
const ProgrammeRow: FC<RowProps> = ({ detail }) => {
  const administrator = useIsAdministrator();
  const { output } = detail;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <FilmStripIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          Programme
          {detail.agent && (
            <StatusLabel status={detail.programmeStatus}>{statusLabels[detail.programmeStatus]}</StatusLabel>
          )}
        </ItemTitle>
        <ItemDescription>
          {detail.encoding} · {output.width} × {output.height} · keyframes every {output.keyframeSeconds} s
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          <EncodingDialog output={output} />
        </ItemActions>
      )}
    </Item>
  );
};

/** Whether OBS records the programme, and for administrators, turning it on or off. */
const RecorderRow: FC<RowProps> = ({ detail }) => {
  const administrator = useIsAdministrator();
  const { recorder, agent } = detail;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <RecordIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          Recording
          {recorder && agent && (
            <StatusLabel status={detail.recorderStatus}>{statusLabels[detail.recorderStatus]}</StatusLabel>
          )}
        </ItemTitle>
        <ItemDescription>
          {recorder
            ? `OBS records the programme alongside streaming it, on ${agent?.name ?? 'its agent'}.`
            : 'Off: nothing keeps a copy of the programme.'}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {administrator ? (
          <RecorderSwitch output={detail.output} />
        ) : (
          <span className="text-custom-13 text-custom-text-secondary">{recorder ? 'On' : 'Off'}</span>
        )}
      </ItemActions>
    </Item>
  );
};

interface ForwardRowProps {
  outputId: string;
  part: ForwardPart;
}

/**
 * A channel the output goes to: what it is, how it is doing, what its platform last said of it, and for
 * administrators, switching or removing it.
 */
const ForwardRow: FC<ForwardRowProps> = ({ outputId, part }) => {
  const administrator = useIsAdministrator();
  const { forward, channel } = part;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">{channel?.kind === 'twitch' ? <TwitchLogoIcon /> : <BroadcastIcon />}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {part.name}
          {forward.enabled ? (
            <StatusLabel status={part.status}>{statusLabels[part.status]}</StatusLabel>
          ) : (
            <StatusLabel status="unknown">Off</StatusLabel>
          )}
          {channel && (
            <Suspense fallback={null}>
              <ChannelPlatformState channelId={channel.id} />
            </Suspense>
          )}
        </ItemTitle>
        <ItemDescription>
          {channelDescriptionOf(channel)} · added {formatDate(forward.createdAt)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {administrator ? (
          <>
            <ForwardSwitch outputId={outputId} part={part} />
            <RemoveForwardDialog outputId={outputId} part={part} />
          </>
        ) : (
          <span className="text-custom-13 text-custom-text-secondary">{forward.enabled ? 'On' : 'Off'}</span>
        )}
      </ItemActions>
    </Item>
  );
};

/** What a channel is, in a few words: its Twitch login, or that it is an RTMP destination. */
function channelDescriptionOf(channel: Channel | undefined): string {
  if (!channel) return 'Its channel was removed';
  if (channel.kind === 'twitch' && channel.externalLogin) return `twitch.tv/${channel.externalLogin}`;
  return channel.kind === 'twitch' ? 'Twitch' : 'RTMP destination';
}

interface PreviewSummaryProps {
  part: PreviewPart;
  /** The agent's name, which publishes it; undefined while the output has none. */
  agent: string | undefined;
  /** Anything more about it, under where it is read from. */
  children?: ReactNode;
}

/** A preview's gateway and status, where it can be read from, and who publishes it, as a delivery's summary is laid out. */
const PreviewSummary: FC<PreviewSummaryProps> = ({ part, agent, children }) => {
  const internet = part.network === null;
  return (
    <>
      <ItemMedia variant="icon">{internet ? <CloudIcon /> : <HardDrivesIcon />}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {part.name}
          <StatusLabel status={part.status}>{statusLabels[part.status]}</StatusLabel>
        </ItemTitle>
        <ItemDescription>
          {internet ? 'Read from anywhere' : `Read on ${part.network}`} ·{' '}
          {agent ? `published by ${agent}` : 'nothing publishes it without an agent'}
        </ItemDescription>
        {children}
      </ItemContent>
    </>
  );
};

/**
 * Where the output's previews can be read: first from anywhere, those at gateways on the internet; then each
 * network's, which only readers on that network reach. Each is read as a stream's delivery to the same gateway is.
 */
const PreviewsPanel: FC<RowProps> = ({ detail }) => {
  const internet = detail.previews.filter(part => part.network === null);
  // Each network's previews together, under its name, in the order the output's previews first reach it.
  const networks = [...new Set(detail.previews.flatMap(part => (part.network === null ? [] : [part.network])))];
  const local = networks.map(network => ({
    network,
    previews: detail.previews.filter(part => part.network === network)
  }));
  return (
    <div className="flex flex-col gap-10">
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>On the internet</SectionTitle>
            <SectionDescription>
              Where the programme can be watched from anywhere, as it goes out. A preview offers it as OBS encodes it.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        {internet.length > 0 ? (
          <ItemGroup className="gap-2">
            {internet.map(part => (
              <PreviewOutput key={part.preview.id} detail={detail} part={part} />
            ))}
          </ItemGroup>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Not previewed on the internet</EmptyTitle>
              <EmptyDescription>
                Add a preview at conservation.tv from Configuration to watch it anywhere.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Section>
      {local.map(({ network, previews }) => (
        <Section key={network}>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle className="flex items-center gap-2">
                <NetworkIcon className="size-4 text-custom-icon-stream" aria-hidden="true" />
                On {network}
              </SectionTitle>
              <SectionDescription>
                Only for readers on {network}: its gateway is served there, at addresses the internet can’t reach. Each
                reader asks for its own short-lived token, which goes beside the address.
              </SectionDescription>
            </SectionHeading>
          </SectionHeader>
          <ItemGroup className="gap-2">
            {previews.map(part => (
              <PreviewOutput key={part.preview.id} detail={detail} part={part} />
            ))}
          </ItemGroup>
        </Section>
      ))}
    </div>
  );
};

/** A preview offers the programme as OBS encodes it: the one rendition. */
const PREVIEW_RENDITIONS = ['default' as const];

/**
 * A preview at a MediaMTX gateway is read by HLS alone: OBS encodes the programme with B-frames, which WebRTC refuses
 * (apps/studio/api/src/gateways/connect.ts).
 */
const PREVIEW_PROTOCOLS = ['hls' as const];

interface PreviewOutputProps {
  detail: OutputDetail;
  part: PreviewPart;
}

/**
 * A preview's card: its gateway and health, then how to read it, as a stream's delivery to that gateway is read: over
 * MoQ at conservation.tv, by HLS at a MediaMTX gateway; for anything else, just what it is.
 */
const PreviewOutput: FC<PreviewOutputProps> = ({ detail, part }) => {
  const organisationId = useOrganisationId();
  const outputId = detail.output.id;
  const previewId = part.preview.id;
  const conservationtv = part.preview.gatewayId === CONSERVATIONTV_GATEWAY;
  if (!conservationtv && part.gateway?.kind !== 'mediamtx') {
    return (
      <DeliveryRow>
        <PreviewSummary part={part} agent={detail.agent?.name} />
      </DeliveryRow>
    );
  }
  return (
    // As a stream's outputs: the tabs and rows run to the card's edges, so the card's own padding is the summary's alone.
    <DeliveryRow className="flex-col flex-nowrap items-stretch gap-0 p-0">
      <div className="flex items-start gap-2.5 px-5 pt-3.5 pb-2">
        <PreviewSummary part={part} agent={detail.agent?.name} />
      </div>
      {conservationtv ? (
        <MoqRead
          read={previewMoqReadQueryOptions(organisationId, outputId, previewId)}
          renditions={PREVIEW_RENDITIONS}
        />
      ) : (
        <LocalRead
          read={(protocol, rendition) =>
            previewReadQueryOptions(organisationId, outputId, previewId, protocol, rendition)
          }
          renditions={PREVIEW_RENDITIONS}
          protocols={PREVIEW_PROTOCOLS}
          name={gatewayNameOf(part.gateway)}
        />
      )}
    </DeliveryRow>
  );
};

/** What recording an output amounts to: OBS keeping a copy of the programme on its agent's machine. */
const RecordingPanel: FC<RowProps> = ({ detail }) => {
  const { agent } = detail;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Recording</SectionTitle>
          <SectionDescription>
            With recording on, OBS records the programme alongside streaming it, into its agent’s data directory
            {agent ? ` on ${agent.name}` : ''}. Recordings stay on that machine: the studio doesn’t list or play them
            back.
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <ItemGroup className="gap-2">
        <RecorderRow detail={detail} />
      </ItemGroup>
      {!agent && (
        <p className="text-custom-13 text-muted-foreground">
          Nothing records until the output has an agent: OBS runs there.
        </p>
      )}
    </Section>
  );
};
