import { Suspense, useState, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { NetworkIcon, PlayIcon, RecordIcon, VideoCameraIcon, XIcon } from '@phosphor-icons/react';
import { useLocation } from 'react-router';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { z } from 'zod';
import type { Camera, Stream } from '@conservationtv/studio-sdk';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import { Button } from '@conservationtv/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
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

import type { Route } from './+types/stream';
import { PinButton } from '@/components/app/pins';
import {
  Fact,
  FactLabel,
  Facts,
  FactValue,
  BackLink,
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
import { CTVMoQPreview } from '@/components/streams/ctv-moq-preview';
import {
  DeliveryGroup,
  DeliveryGroupHeading,
  DeliveryRow,
  DeliveryRows,
  DeliverySummary,
  Renditions
} from '@/components/streams/delivery-list';
import {
  AddExposureDialog,
  DeleteExposureDialog,
  EditExposureDialog,
  type ExposureChoices
} from '@/components/streams/exposure-dialogs';
import { gatewayNameOf } from '@/components/gateways/gateways';
import { LocalRead } from '@/components/streams/local-read';
import { MoqRead } from '@/components/streams/output-read';
import { AddRecorderDialog, DeleteRecorderDialog, EditRecorderDialog } from '@/components/streams/recorder-dialogs';
import { CONSERVATIONTV_GATEWAY, renditionLabels } from '@/components/streams/renditions';
import { BitrateChartLegend } from '@/components/streams/stream-chart';
import { STREAM_LINES } from '@/components/streams/stream-charts';
import { streamDetailOf, type Delivery, type StreamDetail } from '@/components/streams/stream-detail';
import { DeleteStreamDialog, RenameStreamDialog, SourceSelect } from '@/components/streams/stream-dialogs';
import { TopologyDiagram } from '@/components/streams/stream-topology';
import { StreamTrafficChart } from '@/components/streams/stream-traffic';
import { useTabsQuery } from '@/hooks/use-tabs-query';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { formatDate } from '@/lib/format';
import { cameraListQueryOptions } from '@/queries/cameras';
import { deviceListQueryOptions } from '@/queries/devices';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import {
  exposureReadQueryOptions,
  moqReadQueryOptions,
  streamListQueryOptions,
  subjectStateListQueryOptions
} from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Stream · conservation.tv studio' }];

/**
 * One stream: how it is delivered (its source, then each gateway it goes to, on its networks and the internet), what
 * records it, where it can be watched from outside, and its traffic. Everyone reads it; administrators change it.
 */
const StreamRoute: FC<Route.ComponentProps> = ({ params }) => {
  return (
    <Page className="max-w-5xl gap-6">
      <BackLink to=".." relative="path">
        Streams
      </BackLink>
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <StreamView streamId={params.streamId} />
      </Suspense>
    </Page>
  );
};

export default StreamRoute;

interface StreamViewProps {
  streamId: string;
}

/** The stream and everything it names, read at once from the organisation's lists, then laid out in render. */
const StreamView: FC<StreamViewProps> = ({ streamId }) => {
  const organisationId = useOrganisationId();
  const [streamQuery, camerasQuery, devicesQuery, gatewaysQuery, networksQuery, statesQuery] = useSuspenseQueries({
    queries: [
      {
        ...streamListQueryOptions(organisationId),
        select: (streams: Stream[]) => streams.find(stream => stream.id === streamId)
      },
      cameraListQueryOptions(organisationId),
      deviceListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  const stream = streamQuery.data;
  if (!stream) return <StreamNotFound />;
  const detail = streamDetailOf({
    stream,
    cameras: camerasQuery.data,
    devices: devicesQuery.data,
    gateways: gatewaysQuery.data,
    networks: networksQuery.data,
    states: statesQuery.data
  });
  const choices: ExposureChoices = {
    stream,
    gateways: gatewaysQuery.data,
    networks: networksQuery.data,
    devices: devicesQuery.data,
    sourceCamera: detail.sourceCamera,
    sourceName: detail.source?.name
  };
  return (
    <>
      <PageHeader className="items-center">
        <PageHeading className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <PageTitle className="min-w-0 truncate">{stream.name}</PageTitle>
          <StatusLabel status={detail.liveness.status} className="text-custom-13">
            {detail.liveness.label}
          </StatusLabel>
        </PageHeading>
        <PageActions>
          <PinButton label={stream.name} kind="stream" />
        </PageActions>
      </PageHeader>
      <DeliveryFailureNote />
      <StreamTabs detail={detail} choices={choices} cameras={camerasQuery.data} />
    </>
  );
};

/** What the new-stream page passes on when a delivery it asked for was refused after the stream was made. */
const DeliveryFailureSchema = z.object({ deliveryFailure: z.string() });
type DeliveryFailure = z.output<typeof DeliveryFailureSchema>;

/** Says which delivery the new-stream page couldn't make, and why, until it is dismissed or the page is left. */
const DeliveryFailureNote: FC = () => {
  const location = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const parsed = DeliveryFailureSchema.safeParse(location.state);
  if (!parsed.success || dismissed) return null;
  const failure: DeliveryFailure = parsed.data;
  return (
    <Alert variant="destructive">
      <AlertTitle>The stream was made, but not all of its deliveries</AlertTitle>
      <AlertDescription>{failure.deliveryFailure} Add the rest from Configuration below.</AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
};

/** An ID that names no stream of this organisation: deleted, or never one. */
const StreamNotFound: FC = () => {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <VideoCameraIcon />
        </EmptyMedia>
        <EmptyTitle>Stream not found</EmptyTitle>
        <EmptyDescription>It may have been deleted, or it belongs to another organisation.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

interface StreamTabsProps {
  detail: StreamDetail;
  choices: ExposureChoices;
  cameras: Camera[];
}

/** Whether the live preview is open, as `?watch=true` in its address, so a link can open the stream playing. */
const watchParser = parseAsBoolean.withDefault(false);

/** Configuration, recording and outputs, under line tabs, with the live preview a button away at the row's end. */
const StreamTabs: FC<StreamTabsProps> = ({ detail, choices, cameras }) => {
  const tabs = useTabsQuery('tab', ['configuration', 'recording', 'outputs']);
  const [watching, setWatching] = useQueryState('watch', watchParser);
  return (
    <Tabs {...tabs} className="gap-8">
      <div className="flex items-center justify-between gap-4 border-b border-border pb-1">
        <TabsList variant="line" className="justify-start">
          <TabsTrigger value="configuration" className="flex-none px-2 text-custom-13">
            Configuration
          </TabsTrigger>
          <TabsTrigger value="recording" className="flex-none px-2 text-custom-13">
            Recording
            {detail.stream.recorders.length > 0 && (
              <span className="text-muted-foreground tabular-nums">{detail.stream.recorders.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="outputs" className="flex-none px-2 text-custom-13">
            Outputs
          </TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="sm" aria-pressed={watching} onClick={() => setWatching(!watching)}>
          {watching ? <XIcon /> : <PlayIcon />}
          {watching ? 'Close preview' : 'Watch live'}
        </Button>
      </div>
      {watching && (
        <div
          ref={element => element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
          className="flex w-full max-w-3xl flex-col gap-2 self-center"
        >
          <CTVMoQPreview stream={detail.stream.id} />
          {detail.liveness.status !== 'ok' && (
            <p className="text-custom-12 text-muted-foreground">
              Nothing reports this stream as live, so the picture may stay dark.
            </p>
          )}
        </div>
      )}
      <TabsContent value="configuration" className="flex flex-col gap-12">
        <ConfigurationPanel detail={detail} choices={choices} cameras={cameras} />
      </TabsContent>
      <TabsContent value="recording">
        <RecordingPanel detail={detail} />
      </TabsContent>
      <TabsContent value="outputs">
        <OutputsPanel detail={detail} />
      </TabsContent>
    </Tabs>
  );
};

/** The stream's name and source, its delivery drawn and as rows to change, its traffic, and deleting it. */
const ConfigurationPanel: FC<StreamTabsProps> = ({ detail, choices, cameras }) => {
  const administrator = useIsAdministrator();
  const { stream } = detail;
  return (
    <>
      <Section>
        <Facts>
          <Fact>
            <FactLabel>Name</FactLabel>
            <FactValue className="flex items-center gap-1">
              <span className="truncate">{stream.name}</span>
              {administrator && <RenameStreamDialog stream={stream} />}
            </FactValue>
          </Fact>
          <Fact>
            <FactLabel>Source</FactLabel>
            <FactValue className="overflow-visible">
              {administrator ? (
                <SourceSelect stream={stream} cameras={cameras} source={detail.source} />
              ) : (
                (detail.source?.name ?? 'None: published to it')
              )}
            </FactValue>
          </Fact>
          <Fact>
            <FactLabel>Created</FactLabel>
            <FactValue>{formatDate(stream.createdAt)}</FactValue>
          </Fact>
        </Facts>
      </Section>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Delivery</SectionTitle>
            <SectionDescription>
              The gateways it is sent to, on its networks and the internet, and what feeds each.
            </SectionDescription>
          </SectionHeading>
          {administrator && <AddExposureDialog choices={choices} />}
        </SectionHeader>
        {detail.topology.nodes.length > 0 && (
          <div className="rounded-xl border border-border p-5">
            <TopologyDiagram topology={detail.topology} statuses={detail.statuses} />
          </div>
        )}
        {detail.sections.length > 0 ? (
          detail.sections.map(section => (
            <DeliveryGroup key={section.networkId ?? 'internet'}>
              <DeliveryGroupHeading section={section} />
              <DeliveryRows>
                {section.deliveries.map(delivery => (
                  <DeliveryRow key={delivery.exposure.id}>
                    <DeliverySummary delivery={delivery}>
                      <Renditions renditions={delivery.exposure.renditions} />
                    </DeliverySummary>
                    {administrator && (
                      <ItemActions>
                        <EditExposureDialog choices={choices} delivery={delivery} />
                        <DeleteExposureDialog choices={choices} delivery={delivery} />
                      </ItemActions>
                    )}
                  </DeliveryRow>
                ))}
              </DeliveryRows>
            </DeliveryGroup>
          ))
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Not delivered anywhere yet</EmptyTitle>
              <EmptyDescription>
                Add a delivery to send it to a gateway on one of your networks, or to conservation.tv.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Section>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Traffic</SectionTitle>
            <SectionDescription>The last three hours, in bits a second.</SectionDescription>
          </SectionHeading>
          <BitrateChartLegend lines={STREAM_LINES} />
        </SectionHeader>
        {stream.exposures.length > 0 ? (
          <Suspense fallback={<Skeleton className="h-52 w-full" />}>
            <StreamTrafficChart stream={stream} />
          </Suspense>
        ) : (
          <p className="text-custom-13 text-muted-foreground">
            There’s nothing to chart until it’s delivered somewhere.
          </p>
        )}
      </Section>
      {administrator && (
        <Section className="border-t border-border pt-8">
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Delete this stream</SectionTitle>
              <SectionDescription>Its deliveries and recorders go with it. Its camera stays.</SectionDescription>
            </SectionHeading>
            <DeleteStreamDialog stream={stream} />
          </SectionHeader>
        </Section>
      )}
    </>
  );
};

interface PanelProps {
  detail: StreamDetail;
}

/** The stream's recorders, which delivery and rendition each keeps, and what recording amounts to today. */
const RecordingPanel: FC<PanelProps> = ({ detail }) => {
  const administrator = useIsAdministrator();
  const { stream } = detail;
  const deliveries = detail.sections.flatMap(section => section.deliveries);
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Recorders</SectionTitle>
          <SectionDescription>
            A recorder names one delivery and the rendition of it to keep. Nothing acts on recorders yet: no agent
            records, and there are no archives to play back.
          </SectionDescription>
        </SectionHeading>
        {administrator && <AddRecorderDialog streamId={stream.id} deliveries={deliveries} />}
      </SectionHeader>
      {stream.recorders.length > 0 ? (
        <ItemGroup className="gap-2">
          {stream.recorders.map(recorder => (
            <Item key={recorder.id} variant="outline">
              <ItemMedia variant="icon">
                <RecordIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {deliveryName(deliveries, recorder.exposureId)} · {renditionLabels[recorder.rendition]}
                </ItemTitle>
                <ItemDescription>
                  {recorder.kind} · added {formatDate(recorder.createdAt)}
                </ItemDescription>
              </ItemContent>
              {administrator && (
                <ItemActions>
                  <EditRecorderDialog streamId={stream.id} recorder={recorder} deliveries={deliveries} />
                  <DeleteRecorderDialog streamId={stream.id} recorder={recorder} />
                </ItemActions>
              )}
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RecordIcon />
            </EmptyMedia>
            <EmptyTitle>No recorders</EmptyTitle>
            <EmptyDescription>
              {deliveries.length > 0
                ? 'Nothing is set to be recorded.'
                : 'A recorder records a delivery, so add a delivery first.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );
};

function deliveryName(deliveries: Delivery[], exposureId: string): string {
  return deliveries.find(delivery => delivery.exposure.id === exposureId)?.name ?? 'Unknown delivery';
}

/**
 * Where the stream can be read: first from anywhere, its deliveries to gateways on the internet; then each network's own
 * delivery, which only readers on that network reach.
 */
const OutputsPanel: FC<PanelProps> = ({ detail }) => {
  const outputs = detail.sections.filter(section => section.networkId === null).flatMap(section => section.deliveries);
  const local = detail.sections.filter(section => section.networkId !== null && section.deliveries.length > 0);
  return (
    <div className="flex flex-col gap-10">
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>On the internet</SectionTitle>
            <SectionDescription>
              Where the stream can be watched from outside its networks. Readers on a network can read its own gateway
              instead, below.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        {outputs.length > 0 ? (
          <ItemGroup className="gap-2">
            {outputs.map(output => (
              <Output key={output.exposure.id} streamId={detail.stream.id} output={output} />
            ))}
          </ItemGroup>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Not on the internet</EmptyTitle>
              <EmptyDescription>
                It’s only on its own network. Deliver it to conservation.tv from Configuration to watch it anywhere.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Section>
      {local.map(section => (
        <Section key={section.networkId}>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle className="flex items-center gap-2">
                <NetworkIcon className="size-4 text-custom-icon-stream" aria-hidden="true" />
                On {section.label}
              </SectionTitle>
              <SectionDescription>
                Only for readers on {section.label}: its gateway is served there, at addresses the internet can’t reach.
                Each reader asks for its own short-lived token, which goes beside the address.
              </SectionDescription>
            </SectionHeading>
          </SectionHeader>
          <ItemGroup className="gap-2">
            {section.deliveries.map(delivery => (
              <LocalOutput key={delivery.exposure.id} streamId={detail.stream.id} delivery={delivery} />
            ))}
          </ItemGroup>
        </Section>
      ))}
    </div>
  );
};

interface LocalOutputProps {
  streamId: string;
  delivery: Delivery;
}

/**
 * A delivery on a network: its gateway and health, then for a MediaMTX gateway its renditions as tabs, each listing
 * the ways to read it; for anything else, just its renditions.
 */
const LocalOutput: FC<LocalOutputProps> = ({ streamId, delivery }) => {
  const organisationId = useOrganisationId();
  if (delivery.gateway?.kind !== 'mediamtx') {
    return (
      <DeliveryRow>
        <DeliverySummary delivery={delivery}>
          <Renditions renditions={delivery.exposure.renditions} />
        </DeliverySummary>
      </DeliveryRow>
    );
  }
  return (
    // The tabs and their rows run to the card's edges, so the card's own padding is the summary's alone.
    <DeliveryRow className="flex-col flex-nowrap items-stretch gap-0 p-0">
      <div className="flex items-start gap-2.5 px-5 pt-3.5 pb-2">
        <DeliverySummary delivery={delivery} />
      </div>
      <LocalRead
        read={(protocol, rendition) =>
          exposureReadQueryOptions(organisationId, streamId, delivery.exposure.id, protocol, rendition)
        }
        renditions={delivery.exposure.renditions}
        name={gatewayNameOf(delivery.gateway)}
      />
    </DeliveryRow>
  );
};

interface OutputProps {
  streamId: string;
  output: Delivery;
}

/**
 * An internet delivery: its gateway and health, then for conservation.tv its renditions as tabs and how to read it,
 * laid out as a network delivery's card is; for anything else, just its renditions.
 */
const Output: FC<OutputProps> = ({ streamId, output }) => {
  const organisationId = useOrganisationId();
  if (output.exposure.gatewayId !== CONSERVATIONTV_GATEWAY) {
    return (
      <DeliveryRow>
        <DeliverySummary delivery={output}>
          <Renditions renditions={output.exposure.renditions} />
        </DeliverySummary>
      </DeliveryRow>
    );
  }
  return (
    // As LocalOutput: the tabs and rows run to the card's edges, so the card's own padding is the summary's alone.
    <DeliveryRow className="flex-col flex-nowrap items-stretch gap-0 p-0">
      <div className="flex items-start gap-2.5 px-5 pt-3.5 pb-2">
        <DeliverySummary delivery={output} />
      </div>
      <MoqRead
        read={moqReadQueryOptions(organisationId, streamId, output.exposure.id)}
        renditions={output.exposure.renditions}
      />
    </DeliveryRow>
  );
};
