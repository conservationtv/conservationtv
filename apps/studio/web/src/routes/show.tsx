import { Suspense, useState, type FC, type ReactNode } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import {
  BroadcastIcon,
  CloudIcon,
  FilmStripIcon,
  HardDrivesIcon,
  MonitorPlayIcon,
  NetworkIcon,
  PlayIcon,
  RecordIcon,
  TwitchLogoIcon,
  XIcon
} from '@phosphor-icons/react';
import type { Agent, Channel, Show } from '@conservationtv/studio-sdk';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@conservationtv/ui/components/tabs';

import type { Route } from './+types/show';
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
import { BroadcastStage } from '@/components/shows/broadcast-stage';
import {
  ClearOutputDialog,
  DeleteShowDialog,
  EncodingDialog,
  OutputSelect,
  RenameShowDialog
} from '@/components/shows/show-dialogs';
import { showDetailOf, type ForwardPart, type PreviewPart, type ShowDetail } from '@/components/shows/show-detail';
import { ShowLive } from '@/components/shows/show-live';
import {
  AddForwardMenu,
  AddPreviewMenu,
  ForwardSwitch,
  RecorderSwitch,
  RemoveForwardDialog,
  RemovePreviewDialog
} from '@/components/shows/show-parts';
import { ShowTraffic } from '@/components/shows/show-traffic';
import { DeliveryRow } from '@/components/streams/delivery-list';
import { LocalRead } from '@/components/streams/local-read';
import { MoqRead } from '@/components/streams/output-read';
import { CONSERVATIONTV_GATEWAY } from '@/components/streams/renditions';
import { TopologyDiagram } from '@/components/streams/stream-topology';
import { statusLabels } from '@/components/streams/topology';
import { useIsAdministrator, useOrganisation, useOrganisationId } from '@/hooks/use-organisation';
import { formatDate } from '@/lib/format';
import { agentListQueryOptions } from '@/queries/agents';
import { channelListQueryOptions } from '@/queries/channels';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { previewMoqReadQueryOptions, previewReadQueryOptions, showListQueryOptions } from '@/queries/shows';
import { subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Show · conservation.tv studio' }];

/**
 * One show, laid out as a stream's page is: how it goes out (its output agent, its programme, the channels it is
 * forwarded to and the gateways it is previewed at), how to read its previews, its recording, and its traffic, with
 * the organisation's broadcast, which it follows, a button away. Everyone reads it; administrators change it.
 */
const ShowRoute: FC<Route.ComponentProps> = ({ params }) => {
  return (
    <Page className="max-w-5xl gap-6">
      <BackLink to=".." relative="path">
        Shows
      </BackLink>
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <ShowView showId={params.showId} />
      </Suspense>
    </Page>
  );
};

export default ShowRoute;

interface ShowViewProps {
  showId: string;
}

/** The show and everything it names, read at once from the organisation's lists, then laid out in render. */
const ShowView: FC<ShowViewProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const [showsQuery, agentsQuery, channelsQuery, gatewaysQuery, networksQuery, statesQuery] = useSuspenseQueries({
    queries: [
      {
        ...showListQueryOptions(organisationId),
        // This show, and the others, whose outputs an agent can't also be.
        select: (shows: Show[]) => ({ show: shows.find(show => show.id === showId), shows })
      },
      agentListQueryOptions(organisationId),
      channelListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  const { show, shows } = showsQuery.data;
  if (!show) return <ShowNotFound />;
  const detail = showDetailOf({
    show,
    agents: agentsQuery.data,
    channels: channelsQuery.data.channels,
    gateways: gatewaysQuery.data,
    networks: networksQuery.data,
    states: statesQuery.data
  });
  const choices: ShowChoices = {
    shows,
    agents: agentsQuery.data,
    channels: channelsQuery.data.channels,
    gateways: gatewaysQuery.data
  };
  return (
    <>
      <PageHeader className="items-center">
        <PageHeading className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <PageTitle className="min-w-0 truncate">{show.name}</PageTitle>
          <StatusLabel status={detail.liveness.status} className="text-custom-13">
            {detail.liveness.label}
          </StatusLabel>
        </PageHeading>
        <PageActions>
          <PinButton label={show.name} kind="show" />
        </PageActions>
      </PageHeader>
      <ShowTabs detail={detail} choices={choices} />
    </>
  );
};

/** An ID that names no show of this organisation: deleted, or never one. */
const ShowNotFound: FC = () => {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MonitorPlayIcon />
        </EmptyMedia>
        <EmptyTitle>Show not found</EmptyTitle>
        <EmptyDescription>It may have been deleted, or it belongs to another organisation.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/** What the show's controls choose among: the organisation's shows, agents, channels and gateways. */
interface ShowChoices {
  shows: Show[];
  agents: Agent[];
  channels: Channel[];
  gateways: ListedGateway[];
}

interface ShowTabsProps {
  detail: ShowDetail;
  choices: ShowChoices;
}

/** Configuration, outputs, recording and traffic, under line tabs, with the broadcast a button away at the row's end. */
const ShowTabs: FC<ShowTabsProps> = ({ detail, choices }) => {
  const organisation = useOrganisation();
  const [watching, setWatching] = useState(false);
  return (
    <Tabs defaultValue="configuration" className="gap-8">
      <div className="flex items-center justify-between gap-4 border-b border-border pb-1">
        <TabsList variant="line" className="justify-start">
          <TabsTrigger value="configuration" className="flex-none px-2 text-custom-13">
            Configuration
          </TabsTrigger>
          <TabsTrigger value="outputs" className="flex-none px-2 text-custom-13">
            Outputs
            {detail.previews.length > 0 && (
              <span className="text-muted-foreground tabular-nums">{detail.previews.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="recording" className="flex-none px-2 text-custom-13">
            Recording
          </TabsTrigger>
          <TabsTrigger value="traffic" className="flex-none px-2 text-custom-13">
            Traffic
          </TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="sm" aria-pressed={watching} onClick={() => setWatching(!watching)}>
          {watching ? <XIcon /> : <PlayIcon />}
          {watching ? 'Close broadcast' : 'Watch broadcast'}
        </Button>
      </div>
      {watching && (
        <div
          ref={element => element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
          className="flex w-full max-w-3xl flex-col gap-2 self-center"
        >
          {/* A new organisation is a new stream, so its broadcast starts over. */}
          <BroadcastStage key={organisation.id} />
          <p className="text-custom-12 text-muted-foreground">
            {organisation.name}’s broadcast, which every one of its shows follows for now: what this show sends out, as
            its channels see it.
          </p>
        </div>
      )}
      <TabsContent value="configuration" className="flex flex-col gap-12">
        <ConfigurationPanel detail={detail} choices={choices} />
      </TabsContent>
      <TabsContent value="outputs">
        <OutputsPanel detail={detail} />
      </TabsContent>
      <TabsContent value="recording">
        <RecordingPanel detail={detail} />
      </TabsContent>
      <TabsContent value="traffic">
        <Suspense fallback={<Skeleton className="h-52 w-full" />}>
          <ShowTraffic detail={detail} />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
};

/** What OBS is doing on the output agent now, its way out drawn and as rows to change, and deleting it. */
const ConfigurationPanel: FC<ShowTabsProps> = ({ detail, choices }) => {
  const administrator = useIsAdministrator();
  const { show } = detail;
  return (
    <>
      <ShowFacts show={show} />
      <RightNow detail={detail} />
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Going out</SectionTitle>
            <SectionDescription>
              The agent that runs OBS for it, the programme OBS encodes, and the channels and previews it goes to.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <div className="rounded-xl border border-border p-5">
          {detail.topology.nodes.length > 0 ? (
            <TopologyDiagram topology={detail.topology} statuses={detail.statuses} />
          ) : (
            <p className="text-custom-13 text-muted-foreground">
              Nothing sends it out until it has an output agent: choose one below.
            </p>
          )}
        </div>
        <ItemGroup className="gap-2">
          <OutputRow detail={detail} choices={choices} />
          <ProgrammeRow detail={detail} />
          <RecorderRow detail={detail} />
        </ItemGroup>
      </Section>
      <ChannelsSection detail={detail} channels={choices.channels} />
      <PreviewsSection detail={detail} gateways={choices.gateways} />
      {administrator && (
        <Section className="border-t border-border pt-8">
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Delete this show</SectionTitle>
              <SectionDescription>
                It stops going out, and its forwards, previews and recorder go with it. Channels stay.
              </SectionDescription>
            </SectionHeading>
            <DeleteShowDialog show={show} />
          </SectionHeader>
        </Section>
      )}
    </>
  );
};

interface ShowFactsProps {
  show: Show;
}

/** The show's name, with renaming it for administrators, what it shows, and when it was made. */
const ShowFacts: FC<ShowFactsProps> = ({ show }) => {
  const administrator = useIsAdministrator();
  return (
    <Section>
      <Facts>
        <Fact>
          <FactLabel>Name</FactLabel>
          <FactValue className="flex items-center gap-1">
            <span className="truncate">{show.name}</span>
            {administrator && <RenameShowDialog show={show} />}
          </FactValue>
        </Fact>
        <Fact>
          <FactLabel>Picture</FactLabel>
          <FactValue>The organisation’s broadcast</FactValue>
        </Fact>
        <Fact>
          <FactLabel>Created</FactLabel>
          <FactValue>{formatDate(show.createdAt)}</FactValue>
        </Fact>
      </Facts>
    </Section>
  );
};

/**
 * What OBS on the output agent says it is doing, asked of the agent, in its own boundary so an agent that is off
 * doesn't hold the page. Nothing while the show has no output agent the organisation still lists.
 */
const RightNow: FC<RowProps> = ({ detail }) => {
  const { output, show } = detail;
  const publicId = output?.agent?.device?.publicId;
  if (!output || !publicId) return null;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Right now</SectionTitle>
          <SectionDescription>Asked of {output.name} itself, from this browser, every few seconds.</SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <Suspense fallback={<Skeleton className="h-12 w-full" />}>
        <ShowLive publicId={publicId} agentName={output.name} showId={show.id} forwards={detail.forwards} />
      </Suspense>
    </Section>
  );
};

interface ChannelsSectionProps {
  detail: ShowDetail;
  channels: Channel[];
}

/** The channels the show is forwarded to, each on or off, and for administrators, adding another. */
const ChannelsSection: FC<ChannelsSectionProps> = ({ detail, channels }) => {
  const administrator = useIsAdministrator();
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Channels</SectionTitle>
          <SectionDescription>
            Where the output sends the programme. A channel that is off stays the show’s, but isn’t sent anything.
          </SectionDescription>
        </SectionHeading>
        {administrator && <AddForwardMenu show={detail.show} channels={channels} />}
      </SectionHeader>
      {detail.forwards.length > 0 ? (
        <ItemGroup className="gap-2">
          {detail.forwards.map(part => (
            <ForwardRow key={part.forward.id} showId={detail.show.id} part={part} />
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
  detail: ShowDetail;
  gateways: ListedGateway[];
}

/** The gateways the show is previewed at, and for administrators, adding or removing one. */
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
        {administrator && <AddPreviewMenu show={detail.show} gateways={gateways} />}
      </SectionHeader>
      {detail.previews.length > 0 ? (
        <ItemGroup className="gap-2">
          {detail.previews.map(part => (
            <DeliveryRow key={part.preview.id}>
              <PreviewSummary part={part} output={detail.output?.name} />
              {administrator && (
                <ItemActions>
                  <RemovePreviewDialog showId={detail.show.id} part={part} />
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
  detail: ShowDetail;
}

interface OutputRowProps extends RowProps {
  choices: ShowChoices;
}

/** The agent that runs OBS for the show, how it is doing, and for administrators, choosing or clearing it. */
const OutputRow: FC<OutputRowProps> = ({ detail, choices }) => {
  const administrator = useIsAdministrator();
  const { output, show } = detail;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <HardDrivesIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {output ? output.name : 'No output agent'}
          {output && <StatusLabel status={output.status}>{statusLabels[output.status]}</StatusLabel>}
        </ItemTitle>
        <ItemDescription>
          {output
            ? 'Runs OBS for the show: it follows the broadcast, encodes the programme and sends it out.'
            : 'An agent on Windows or macOS runs OBS for the show. Until one is chosen, nothing sends it out.'}
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          <OutputSelect show={show} agents={choices.agents} shows={choices.shows} />
          {output && <ClearOutputDialog show={show} />}
        </ItemActions>
      )}
    </Item>
  );
};

/** The programme OBS encodes, how it is doing, and for administrators, changing its encoding. */
const ProgrammeRow: FC<RowProps> = ({ detail }) => {
  const administrator = useIsAdministrator();
  const { show } = detail;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <FilmStripIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          Programme
          {detail.output && (
            <StatusLabel status={detail.programmeStatus}>{statusLabels[detail.programmeStatus]}</StatusLabel>
          )}
        </ItemTitle>
        <ItemDescription>
          {detail.encoding} · {show.width} × {show.height} · keyframes every {show.keyframeSeconds} s
        </ItemDescription>
      </ItemContent>
      {administrator && (
        <ItemActions>
          <EncodingDialog show={show} />
        </ItemActions>
      )}
    </Item>
  );
};

/** Whether OBS records the programme, and for administrators, turning it on or off. */
const RecorderRow: FC<RowProps> = ({ detail }) => {
  const administrator = useIsAdministrator();
  const { recorder, output } = detail;
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <RecordIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          Recording
          {recorder && output && (
            <StatusLabel status={detail.recorderStatus}>{statusLabels[detail.recorderStatus]}</StatusLabel>
          )}
        </ItemTitle>
        <ItemDescription>
          {recorder
            ? `OBS records the programme alongside streaming it, on ${output?.name ?? 'the output agent'}.`
            : 'Off: nothing keeps a copy of the programme.'}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {administrator ? (
          <RecorderSwitch show={detail.show} />
        ) : (
          <span className="text-custom-13 text-custom-text-secondary">{recorder ? 'On' : 'Off'}</span>
        )}
      </ItemActions>
    </Item>
  );
};

interface ForwardRowProps {
  showId: string;
  part: ForwardPart;
}

/** A channel the show goes to: what it is, how it is doing, what its platform last said of it, and for administrators, switching or removing it. */
const ForwardRow: FC<ForwardRowProps> = ({ showId, part }) => {
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
            <ForwardSwitch showId={showId} part={part} />
            <RemoveForwardDialog showId={showId} part={part} />
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
  /** The output agent's name, which publishes it; undefined while the show has none. */
  output: string | undefined;
  /** Anything more about it, under where it is read from. */
  children?: ReactNode;
}

/** A preview's gateway and status, where it can be read from, and who publishes it, as a delivery's summary is laid out. */
const PreviewSummary: FC<PreviewSummaryProps> = ({ part, output, children }) => {
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
          {output ? `published by ${output}` : 'nothing publishes it without an output agent'}
        </ItemDescription>
        {children}
      </ItemContent>
    </>
  );
};

/**
 * Where the show's previews can be read: first from anywhere, those at gateways on the internet; then each network's,
 * which only readers on that network reach. Each is read as a stream's delivery to the same gateway is.
 */
const OutputsPanel: FC<RowProps> = ({ detail }) => {
  const internet = detail.previews.filter(part => part.network === null);
  // Each network's previews together, under its name, in the order the show's previews first reach it.
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
  detail: ShowDetail;
  part: PreviewPart;
}

/**
 * A preview's card: its gateway and health, then how to read it, as a stream's delivery to that gateway is read: over
 * MoQ at conservation.tv, by HLS at a MediaMTX gateway; for anything else, just what it is.
 */
const PreviewOutput: FC<PreviewOutputProps> = ({ detail, part }) => {
  const organisationId = useOrganisationId();
  const showId = detail.show.id;
  const previewId = part.preview.id;
  const conservationtv = part.preview.gatewayId === CONSERVATIONTV_GATEWAY;
  if (!conservationtv && part.gateway?.kind !== 'mediamtx') {
    return (
      <DeliveryRow>
        <PreviewSummary part={part} output={detail.output?.name} />
      </DeliveryRow>
    );
  }
  return (
    // As a stream's outputs: the tabs and rows run to the card's edges, so the card's own padding is the summary's alone.
    <DeliveryRow className="flex-col flex-nowrap items-stretch gap-0 p-0">
      <div className="flex items-start gap-2.5 px-5 pt-3.5 pb-2">
        <PreviewSummary part={part} output={detail.output?.name} />
      </div>
      {conservationtv ? (
        <MoqRead read={previewMoqReadQueryOptions(organisationId, showId, previewId)} renditions={PREVIEW_RENDITIONS} />
      ) : (
        <LocalRead
          read={(protocol, rendition) =>
            previewReadQueryOptions(organisationId, showId, previewId, protocol, rendition)
          }
          renditions={PREVIEW_RENDITIONS}
          protocols={PREVIEW_PROTOCOLS}
          name={gatewayNameOf(part.gateway)}
        />
      )}
    </DeliveryRow>
  );
};

/** What recording a show amounts to: OBS keeping a copy of the programme on the output agent's machine. */
const RecordingPanel: FC<RowProps> = ({ detail }) => {
  const { output } = detail;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Recording</SectionTitle>
          <SectionDescription>
            With recording on, OBS records the programme alongside streaming it, into the output agent’s data directory
            {output ? ` on ${output.name}` : ''}. Recordings stay on that machine: the studio doesn’t list or play them
            back.
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <ItemGroup className="gap-2">
        <RecorderRow detail={detail} />
      </ItemGroup>
      {!output && (
        <p className="text-custom-13 text-muted-foreground">
          Nothing records until the show has an output agent: OBS runs there.
        </p>
      )}
    </Section>
  );
};
