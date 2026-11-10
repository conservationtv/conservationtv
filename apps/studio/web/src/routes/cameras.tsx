import type { FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link, Outlet } from 'react-router';
import { PlusIcon, VideoCameraIcon } from '@phosphor-icons/react';
import type { Camera, Network, Stream } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
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

import type { Route } from './+types/cameras';
import { CameraStateBadge } from '@/components/cameras/camera-state-badge';
import { cameraAddressOf, cameraDriverLabelOf, cameraStateDetailsOf } from '@/components/cameras/cameras';
import { Page, PageActions, PageDescription, PageHeader, PageHeading, PageTitle } from '@/components/common/page';
import { networkNameOf } from '@/components/devices/devices';
import { SubjectHealth } from '@/components/devices/subject-health';
import { deviceSubjectId, statesBySubject, type SubjectState } from '@/components/devices/subjects';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { cameraListQueryOptions } from '@/queries/cameras';
import { networkListQueryOptions } from '@/queries/networks';
import { streamListQueryOptions, subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Cameras · conservation.tv studio' }];

/**
 * An organisation's cameras: how each is doing, whether it feeds its streams, how it is reached and from which
 * network, and the streams it is the source of. Everyone reads them; administrators add them here, and change or
 * remove each on its own page.
 */
const CamerasRoute: FC = () => {
  const organisationId = useOrganisationId();
  const administrator = useIsAdministrator();
  const [camerasQuery, networksQuery, streamsQuery, statesQuery] = useSuspenseQueries({
    queries: [
      cameraListQueryOptions(organisationId),
      networkListQueryOptions(organisationId),
      streamListQueryOptions(organisationId),
      subjectStateListQueryOptions(organisationId)
    ]
  });
  const cameras = camerasQuery.data;
  const states = statesBySubject(statesQuery.data);
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Cameras</PageTitle>
          <PageDescription>
            The cameras your streams start from. The active agent on each camera’s network pulls from it, but only while
            it is enabled: a locked or disabled camera feeds none of its streams.
          </PageDescription>
        </PageHeading>
        {administrator && (
          <PageActions>
            <Button nativeButton={false} render={<Link to="new" />}>
              <PlusIcon />
              Add camera
            </Button>
          </PageActions>
        )}
      </PageHeader>
      {cameras.length > 0 ? (
        <ItemGroup className="gap-2">
          {cameras.map(camera => (
            <CameraRow
              key={camera.id}
              camera={camera}
              networks={networksQuery.data}
              streams={streamsQuery.data.filter(stream => stream.sourceDeviceId === camera.id)}
              state={states.get(deviceSubjectId(camera.id))}
            />
          ))}
        </ItemGroup>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <VideoCameraIcon />
            </EmptyMedia>
            <EmptyTitle>No cameras yet</EmptyTitle>
            <EmptyDescription>
              {administrator
                ? 'Add a camera by its address on its network, then make a stream from it.'
                : 'An administrator adds cameras, by their address on their network.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {/* A dialog routed over the page, such as adding one: `new`. */}
      <Outlet />
    </Page>
  );
};

export default CamerasRoute;

interface CameraRowProps {
  camera: Camera;
  networks: Network[];
  /** The streams the camera is the source of. */
  streams: Stream[];
  /** What agents last said about the camera. */
  state: SubjectState | undefined;
}

/**
 * A camera, opening its page: its health and state, how it is reached, and the streams it feeds. The whole row is its
 * page's link; the links to its streams sit above it.
 */
const CameraRow: FC<CameraRowProps> = ({ camera, networks, streams, state }) => {
  const organisationId = useOrganisationId();
  const name = camera.device?.name ?? 'Unnamed camera';
  const networkName = networkNameOf(networks, camera.device?.networkId ?? null);
  return (
    <Item variant="outline" className="relative hover:bg-muted/40">
      <ItemMedia variant="icon">
        <VideoCameraIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full">
          <Link
            to={`/organisations/${organisationId}/cameras/${camera.id}`}
            className="truncate after:absolute after:inset-0 after:rounded-md"
          >
            {name}
          </Link>
          <CameraStateBadge state={camera.state} />
        </ItemTitle>
        <ItemDescription className="truncate">
          {cameraDriverLabelOf(camera.settings.driver)} · {cameraAddressOf(camera.settings)} · {networkName}
        </ItemDescription>
        {camera.state !== 'enabled' && (
          <ItemDescription>{cameraStateDetailsOf(camera.state).description}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <SubjectHealth state={state} />
      </ItemActions>
      <ItemFooter className="justify-start gap-3 border-t border-border pt-2.5">
        <span className="text-custom-12 text-custom-text-secondary">{streams.length === 1 ? 'Stream' : 'Streams'}</span>
        {streams.length > 0 ? (
          <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {streams.map(stream => (
              <Link
                key={stream.id}
                to={`/organisations/${organisationId}/streams/${stream.id}`}
                className="relative z-10 text-custom-12 text-foreground underline-offset-2 hover:underline"
              >
                {stream.name}
              </Link>
            ))}
          </span>
        ) : (
          <span className="text-custom-12 text-custom-text-secondary">None yet</span>
        )}
      </ItemFooter>
    </Item>
  );
};
