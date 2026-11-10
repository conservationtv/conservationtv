import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowRightIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import type { Network } from '@conservationtv/studio-sdk';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';

import type { Route } from './+types/publishers';
import { Page, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { DEVICE_KINDS, DeviceKindIcon } from '@/components/devices/device-kind';
import { devicePathOf, networkNameOf } from '@/components/devices/devices';
import { publishersOf, type Publication, type Publisher } from '@/components/devices/publishers';
import { Renditions } from '@/components/streams/delivery-list';
import { SubjectHealth } from '@/components/devices/subject-health';
import { statesBySubject } from '@/components/devices/subjects';
import { useOrganisationId } from '@/hooks/use-organisation';
import { counted } from '@/lib/format';
import { deviceListQueryOptions } from '@/queries/devices';
import { gatewayListQueryOptions } from '@/queries/gateways';
import { networkListQueryOptions } from '@/queries/networks';
import { streamListQueryOptions, subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Publishers · conservation.tv studio' }];

/**
 * What is publishing what, to where: every device that publishes a stream to a gateway (an agent pushing it up to
 * conservation.tv, a member's browser), each with the streams it publishes, where to, in which renditions, and how
 * each delivery is doing. Read-only: a delivery's publisher is chosen on its stream's page.
 */
const PublishersRoute: FC = () => {
  const organisationId = useOrganisationId();
  const [streamsQuery, devicesQuery, gatewaysQuery, statesQuery, networksQuery] = useSuspenseQueries({
    queries: [
      streamListQueryOptions(organisationId),
      deviceListQueryOptions(organisationId),
      gatewayListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId),
      networkListQueryOptions(organisationId)
    ]
  });
  const publishers = publishersOf({
    streams: streamsQuery.data,
    devices: devicesQuery.data,
    gateways: gatewaysQuery.data,
    states: statesBySubject(statesQuery.data)
  });
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Publishers</PageTitle>
          <PageDescription>
            The devices publishing your streams to gateways: an agent pushing a stream up to conservation.tv, say, or
            someone’s browser. A delivery’s publisher is chosen on its stream’s page.
          </PageDescription>
        </PageHeading>
      </PageHeader>
      {publishers.length > 0 ? (
        <div className="flex flex-col gap-4">
          {publishers.map(publisher => (
            <PublisherCard key={publisher.deviceId} publisher={publisher} networks={networksQuery.data} />
          ))}
        </div>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UploadSimpleIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing is publishing</EmptyTitle>
            <EmptyDescription>
              No delivery has a publisher. Choose one for a delivery on its stream’s page, such as the agent that pushes
              it up to conservation.tv.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Page>
  );
};

export default PublishersRoute;

interface PublisherCardProps {
  publisher: Publisher;
  networks: Network[];
}

/** A publishing device, then each stream it publishes. */
const PublisherCard: FC<PublisherCardProps> = ({ publisher, networks }) => {
  const organisationId = useOrganisationId();
  const device = publisher.device;
  const path = device ? devicePathOf(organisationId, device) : undefined;
  const kind = DEVICE_KINDS.find(candidate => candidate.kind === device?.kind)?.label;
  const name = device?.name ?? 'Unknown device';
  return (
    <section className="flex flex-col rounded-lg border">
      <header className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground [&_svg]:size-4">
          {device && <DeviceKindIcon kind={device.kind} />}
        </span>
        <div className="flex min-w-0 flex-col">
          {path ? (
            <Link
              to={path}
              className="truncate text-custom-13 font-medium text-foreground underline-offset-2 hover:underline"
              title={name}
            >
              {name}
            </Link>
          ) : (
            <span className="truncate text-custom-13 font-medium text-foreground" title={name}>
              {name}
            </span>
          )}
          <span className="text-custom-12 text-custom-text-secondary">
            {device ? `${kind ?? device.kind} · ${networkNameOf(networks, device.networkId)}` : 'It has been removed.'}
          </span>
        </div>
        <span className="ml-auto shrink-0 text-custom-12 text-custom-text-secondary">
          {counted(new Set(publisher.publications.map(publication => publication.stream.id)).size, 'stream')}
        </span>
      </header>
      <ul className="flex flex-col divide-y divide-border border-t">
        {publisher.publications.map(publication => (
          <PublicationRow key={publication.exposure.id} publication={publication} />
        ))}
      </ul>
    </section>
  );
};

interface PublicationRowProps {
  publication: Publication;
}

/** One stream the device publishes: where to, in which renditions, and how that delivery is doing. */
const PublicationRow: FC<PublicationRowProps> = ({ publication }) => {
  const organisationId = useOrganisationId();
  const { stream, exposure, gateway, state } = publication;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
      <span className="flex min-w-0 flex-1 items-center gap-2 text-custom-13">
        <Link
          to={`/organisations/${organisationId}/streams/${stream.id}`}
          className="truncate text-foreground underline-offset-2 hover:underline"
          title={stream.name}
        >
          {stream.name}
        </Link>
        <ArrowRightIcon aria-label="to" className="size-3 shrink-0 text-custom-text-secondary" />
        <span className="truncate text-custom-text-secondary">{gateway?.name ?? 'A removed gateway'}</span>
      </span>
      <Renditions renditions={exposure.renditions} />
      <SubjectHealth state={state} />
    </li>
  );
};
