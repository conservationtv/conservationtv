import { Suspense, type ComponentProps, type FC, type ReactNode } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useSuspenseQueries } from '@tanstack/react-query';
import { CloudIcon, HardDrivesIcon, PlusIcon, VideoCameraIcon } from '@phosphor-icons/react';
import { Link, useNavigate } from 'react-router';
import type { Camera, Device, Network, Rendition } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import { Checkbox } from '@conservationtv/ui/components/checkbox';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList
} from '@conservationtv/ui/components/combobox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle
} from '@conservationtv/ui/components/field';
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { RadioGroup, RadioGroupItem } from '@conservationtv/ui/components/radio-group';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { cn } from '@conservationtv/ui/lib/utils';

import type { Route } from './+types/stream-new';
import { FormError } from '@/components/common/form-error';
import { BackLink, Page, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { Renditions } from '@/components/streams/delivery-list';
import {
  draftTopology,
  planDeliveries,
  type DeliveryPlan,
  type PlannedDelivery,
  type SourceKind
} from '@/components/streams/new-stream-plan';
import { PublisherOptions } from '@/components/streams/publisher-options';
import { RenditionsField } from '@/components/streams/renditions-field';
import { sourceRenditions } from '@/components/streams/renditions';
import type { ListedGateway } from '@/components/streams/stream-detail';
import { TopologyDiagram } from '@/components/streams/stream-topology';
import { NewStreamSchema, StreamSourceSchema, type NewStream, type NewStreamInput } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { cameraListQueryOptions } from '@/queries/cameras';
import { deviceListQueryOptions } from '@/queries/devices';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { useCreateStreamWithDeliveries } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'New stream · conservation.tv studio' }];

/**
 * Creating a stream: its name, where it comes from (a camera, or whatever publishes to it), and where it is delivered
 * from the start, drawn as it will be delivered before anything is made. Administrators only.
 */
const StreamNewRoute: FC = () => {
  return (
    <Page className="max-w-4xl gap-6">
      <BackLink to=".." relative="path">
        Streams
      </BackLink>
      <PageHeader>
        <PageHeading>
          <PageTitle>Create new stream</PageTitle>
          <PageDescription>
            A stream is one live picture, from a camera or a publisher, delivered to the gateways it is read from.
          </PageDescription>
        </PageHeading>
      </PageHeader>
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <NewStreamGate />
      </Suspense>
    </Page>
  );
};

export default StreamNewRoute;

/** The form for administrators; everyone else is told who can make one. */
const NewStreamGate: FC = () => {
  const administrator = useIsAdministrator();
  if (administrator) return <NewStreamForm />;
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <VideoCameraIcon />
        </EmptyMedia>
        <EmptyTitle>Only administrators create streams</EmptyTitle>
        <EmptyDescription>Ask an administrator of this organisation to add it.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/**
 * The new stream's fields and the delivery they amount to. Creating makes the stream, then its deliveries in order;
 * if one is refused, the stream already exists, so its page opens saying what wasn't made.
 */
const NewStreamForm: FC = () => {
  const organisationId = useOrganisationId();
  const navigate = useNavigate();
  const [camerasQuery, devicesQuery, gatewaysQuery, networksQuery] = useSuspenseQueries({
    queries: [
      cameraListQueryOptions(organisationId),
      deviceListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      networkListQueryOptions(organisationId)
    ]
  });
  const cameras = camerasQuery.data;
  const gateways = gatewaysQuery.data;
  const networks = networksQuery.data;
  const create = useCreateStreamWithDeliveries(organisationId);
  const defaultValues: NewStreamInput = {
    name: '',
    source: 'camera',
    cameraId: '',
    publisherDeviceId: '',
    deliveries: []
  };
  /** What the form's values amount to: the camera chosen, the gateways open to it, and the deliveries planned. */
  const planOf = (values: NewStreamInput) => {
    const camera = values.source === 'camera' ? cameras.find(({ id }) => id === values.cameraId) : undefined;
    const candidates = candidateGateways(gateways, camera);
    const plan = planDeliveries({
      source: values.source,
      camera,
      publisherDeviceId: values.publisherDeviceId || null,
      deliveries: values.deliveries.filter(delivery => candidates.some(({ id }) => id === delivery.gatewayId)),
      gateways,
      networks
    });
    return { camera, candidates, plan };
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: NewStreamSchema },
    onSubmit: ({ value }) => {
      const stream: NewStream = NewStreamSchema.parse(value);
      const { camera, plan } = planOf(value);
      if (plan.problems.size > 0) return;
      create.mutate(
        { name: stream.name, sourceDeviceId: camera?.id ?? null, deliveries: plan.deliveries },
        {
          onSuccess: ({ stream: made, failure }) =>
            navigate(`../${made.id}`, { relative: 'path', state: failure ? { deliveryFailure: failure } : undefined })
        }
      );
    }
  });
  const values = useStore(form.store, state => state.values);
  const { camera, candidates, plan } = planOf(values);
  const draft = draftTopology({
    sourceDeviceId: camera?.id ?? null,
    plan: plan.deliveries,
    devices: devicesQuery.data,
    gateways,
    networks
  });
  return (
    <form
      className="flex flex-col gap-10"
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup className="max-w-md">
        <form.Field name="name">
          {field => <TextField field={field} label="Name" placeholder="Hide feeder" autoComplete="off" />}
        </form.Field>
      </FieldGroup>
      <form.Field name="source">
        {field => (
          <FieldSet>
            <FieldLegend>Source</FieldLegend>
            <FieldDescription>Where the picture comes from.</FieldDescription>
            <RadioGroup
              className="grid-cols-1 sm:grid-cols-2"
              value={field.state.value}
              onValueChange={value => field.handleChange(StreamSourceSchema.parse(value))}
            >
              <SourceCard value="camera" title="Camera">
                Pulled from a camera on one of your networks, by the network’s agent.
              </SourceCard>
              <SourceCard value="publisher" title="Publisher">
                Published to a gateway from a phone, a PC or OBS, by the device you pin to it.
              </SourceCard>
            </RadioGroup>
          </FieldSet>
        )}
      </form.Field>
      {values.source === 'camera' ? (
        <form.Field name="cameraId">
          {field => (
            <Field data-invalid={field.state.meta.isTouched && !field.state.meta.isValid}>
              <FieldLabel htmlFor="camera-search">Camera</FieldLabel>
              <div className="flex gap-2">
                <CameraPicker
                  cameras={cameras}
                  networks={networks}
                  value={field.state.value}
                  onChange={cameraId => field.handleChange(cameraId)}
                />
                <Button variant="outline" nativeButton={false} render={<Link to="../../cameras" relative="path" />}>
                  <PlusIcon />
                  Add new
                </Button>
              </div>
              <FieldDescription>
                A plain RTSP address is a camera too: add it on the cameras page with the RTSP driver.
              </FieldDescription>
              {field.state.meta.isTouched && <FieldError errors={field.state.meta.errors} />}
            </Field>
          )}
        </form.Field>
      ) : (
        <form.Field name="publisherDeviceId">
          {field => (
            <SelectField
              field={field}
              label="Published by"
              className="max-w-md"
              description="The device that sends it: an agent running OBS, or a browser. Nothing sends it until one is pinned, here or later on its page."
            >
              <NativeSelectOption value="">None yet</NativeSelectOption>
              <PublisherOptions devices={devicesQuery.data} />
            </SelectField>
          )}
        </form.Field>
      )}
      <form.Field name="deliveries" mode="array">
        {deliveriesField => (
          <FieldSet>
            <FieldLegend>Delivery</FieldLegend>
            <FieldDescription>
              Where it goes from the start. On a network, the agent serves it to readers there; conservation.tv makes it
              watchable anywhere.
            </FieldDescription>
            <div className="flex flex-col gap-2">
              {candidates.map(gateway => {
                // A gateway is chosen while the form holds a delivery to it, at `index`; ticking adds one offering
                // the first rendition it can, unticking removes it. Once chosen, it shows its renditions, and why
                // the plan would be refused or leave it unsent.
                const index = values.deliveries.findIndex(delivery => delivery.gatewayId === gateway.id);
                const choices = renditionsFor(gateway, plan, camera, values.source);
                return (
                  <DeliveryCard key={gateway.id}>
                    <DeliveryCardHeader gateway={gateway} networks={networks}>
                      <Checkbox
                        checked={index >= 0}
                        aria-label={`Deliver to ${gateway.name}`}
                        onCheckedChange={checked =>
                          checked
                            ? deliveriesField.pushValue({ gatewayId: gateway.id, renditions: choices.slice(0, 1) })
                            : deliveriesField.removeValue(index)
                        }
                      />
                    </DeliveryCardHeader>
                    {index >= 0 && (
                      <form.Field name={`deliveries[${index}].renditions`}>
                        {field => (
                          <RenditionsField
                            field={field}
                            label="Renditions"
                            choices={choices}
                            description={choices.length === 1 ? onlyRenditionNote(gateway, plan) : undefined}
                          />
                        )}
                      </form.Field>
                    )}
                    {plan.problems.has(gateway.id) && <FieldError>{plan.problems.get(gateway.id)}</FieldError>}
                    {index >= 0 && plan.unsent.has(gateway.id) && (
                      <FieldDescription>{plan.unsent.get(gateway.id)}</FieldDescription>
                    )}
                  </DeliveryCard>
                );
              })}
            </div>
          </FieldSet>
        )}
      </form.Field>
      <section className="flex flex-col gap-3" aria-label="How it will be delivered">
        {draft.topology.nodes.length > 0 ? (
          <div className="rounded-xl border border-border p-5">
            <TopologyDiagram topology={draft.topology} statuses={draft.statuses} />
          </div>
        ) : (
          <p className="text-custom-13 text-muted-foreground">
            Choose a camera or where it goes, and how it will be delivered is drawn here.
          </p>
        )}
        <PlanSummary
          plan={plan.deliveries}
          devices={devicesQuery.data}
          sourceName={values.source === 'camera' ? (camera?.device?.name ?? 'the camera') : 'its publisher'}
        />
      </section>
      <div className="flex flex-col items-start gap-3">
        <FormError error={create.error} />
        <Button type="submit" loading={create.isPending} disabled={plan.problems.size > 0}>
          Create stream
        </Button>
      </div>
    </form>
  );
};

interface SourceCardProps {
  value: SourceKind;
  title: string;
  children: ReactNode;
}

/** One kind of source, as a large card: its name over a line about it, with its radio at the corner. */
const SourceCard: FC<SourceCardProps> = ({ value, title, children }) => {
  return (
    <FieldLabel htmlFor={`source-${value}`}>
      <Field orientation="horizontal" className="p-3!">
        <FieldContent>
          <FieldTitle className="text-custom-13">{title}</FieldTitle>
          <FieldDescription>{children}</FieldDescription>
        </FieldContent>
        <RadioGroupItem value={value} id={`source-${value}`} />
      </Field>
    </FieldLabel>
  );
};

interface CameraPickerProps {
  cameras: Camera[];
  networks: Network[];
  /** The chosen camera's ID, or the empty string. */
  value: string;
  onChange: (cameraId: string) => void;
}

/** Searches the organisation's cameras by name, each shown with the network it is on. */
const CameraPicker: FC<CameraPickerProps> = ({ cameras, networks, value, onChange }) => {
  const nameOf = (cameraId: string) => cameras.find(camera => camera.id === cameraId)?.device?.name ?? 'Unnamed camera';
  return (
    <Combobox
      items={cameras.map(camera => camera.id)}
      value={value || null}
      onValueChange={cameraId => onChange(cameraId ?? '')}
      itemToStringLabel={nameOf}
    >
      <ComboboxInput id="camera-search" className="flex-1" placeholder="Search your cameras" showClear />
      <ComboboxContent>
        <ComboboxEmpty>{cameras.length > 0 ? 'No cameras match.' : 'No cameras yet: add one.'}</ComboboxEmpty>
        <ComboboxList>
          {(cameraId: string) => (
            <ComboboxItem key={cameraId} value={cameraId}>
              {nameOf(cameraId)}
              <span className="text-muted-foreground">{cameraNetworkName(cameras, networks, cameraId)}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};

/** The name of the network a camera is on: nothing when the camera, its device or its network is missing. */
function cameraNetworkName(cameras: Camera[], networks: Network[], cameraId: string): string {
  const networkId = cameras.find(camera => camera.id === cameraId)?.device?.networkId;
  return networks.find(network => network.id === networkId)?.name ?? '';
}

/** A gateway the stream could go to: its header, then what it is to offer once chosen. */
const DeliveryCard: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return (
    <div className={cn('flex flex-col gap-3 rounded-lg border border-border px-3 py-2.5', className)} {...props} />
  );
};

interface DeliveryCardHeaderProps {
  gateway: ListedGateway;
  networks: Network[];
  /** What chooses it: its checkbox, first in the row. */
  children: ReactNode;
}

/** The gateway, where it is, and what chooses it, as one label. */
const DeliveryCardHeader: FC<DeliveryCardHeaderProps> = ({ gateway, networks, children }) => {
  const network = networks.find(candidate => candidate.id === gateway.networkId);
  return (
    <FieldLabel className="items-center font-normal has-data-checked:bg-transparent [&>svg]:size-4 [&>svg]:text-custom-icon-stream">
      {children}
      {gateway.networkId === null ? <CloudIcon aria-hidden="true" /> : <HardDrivesIcon aria-hidden="true" />}
      <span className="text-custom-13 text-foreground">{gateway.name}</span>
      <span className="text-custom-12 text-custom-text-secondary">
        {network ? `on ${network.name}` : 'on the internet'}
      </span>
    </FieldLabel>
  );
};

interface PlanSummaryProps {
  plan: PlannedDelivery[];
  devices: Device[];
  /** What feeds a delivery fed by the source: the camera, by name, or its publisher. */
  sourceName: string;
}

/** Each delivery to be made, in words: what feeds it, who sends it, and what it offers. */
const PlanSummary: FC<PlanSummaryProps> = ({ plan, devices, sourceName }) => {
  if (plan.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2 text-custom-13 text-custom-text-secondary">
      {plan.map(delivery => (
        <li key={delivery.gatewayId} className="flex flex-wrap items-center gap-x-2">
          <span className="text-foreground">{delivery.name}</span>
          <span>
            fed by {upstreamName(plan, delivery) ?? sourceName}, {publisherPhrase(devices, delivery.publisherDeviceId)}
          </span>
          <Renditions renditions={delivery.renditions} />
        </li>
      ))}
    </ul>
  );
};

/** The planned delivery that feeds this one, by name; undefined when the source feeds it. */
function upstreamName(plan: PlannedDelivery[], delivery: PlannedDelivery): string | undefined {
  return plan.find(candidate => candidate.gatewayId === delivery.upstreamGatewayId)?.name;
}

function publisherPhrase(devices: Device[], publisherDeviceId: string | null): string {
  const publisher = devices.find(device => device.id === publisherDeviceId);
  return publisher ? `published by ${publisher.name}` : 'publisher chosen by the system';
}

/**
 * The gateways a stream from this camera can go to, in delivery order: those on the camera's network, then the
 * internet's. Without a camera chosen, or for a publisher's stream, every network's.
 */
function candidateGateways(gateways: ListedGateway[], camera: Camera | undefined): ListedGateway[] {
  const networkId = camera?.device?.networkId;
  const onNetworks = gateways.filter(
    gateway => gateway.networkId !== null && (networkId === undefined || gateway.networkId === networkId)
  );
  return [...onNetworks, ...gateways.filter(gateway => gateway.networkId === null)];
}

/** Why a delivery can offer only one rendition: what feeds it offers only that, or its camera gives only its source. */
function onlyRenditionNote(gateway: ListedGateway, plan: DeliveryPlan): string {
  if (gateway.networkId === null && plan.feeder) return `${plan.feeder.name} offers only this one.`;
  return 'A plain RTSP camera gives only its source, as it is.';
}

/**
 * What a delivery to the gateway can offer: on the internet, fed by a delivery on a network, at most what that one
 * does; otherwise what the source produces.
 */
function renditionsFor(
  gateway: ListedGateway,
  plan: DeliveryPlan,
  camera: Camera | undefined,
  source: SourceKind
): Rendition[] {
  const fromSource = sourceRenditions(source === 'camera' ? camera : undefined);
  // Only an internet delivery is fed by another; until the one feeding it offers something, the source's choices stand.
  if (gateway.networkId !== null || !plan.feeder || plan.feeder.renditions.length === 0) return fromSource;
  return plan.feeder.renditions;
}
