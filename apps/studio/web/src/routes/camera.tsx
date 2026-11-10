import type { FC, ReactNode } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link } from 'react-router';
import { VideoCameraIcon } from '@phosphor-icons/react';
import type { Camera, Network, Stream } from '@conservationtv/studio-sdk';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from '@conservationtv/ui/components/item';

import type { Route } from './+types/camera';
import { PinButton } from '@/components/app/pins';
import { ClearCredentialsDialog, ReplaceCredentialsDialog } from '@/components/cameras/camera-credentials-dialogs';
import { CameraSettingsDialog } from '@/components/cameras/camera-settings-dialog';
import { CameraStateBadge } from '@/components/cameras/camera-state-badge';
import { CameraStateSelect } from '@/components/cameras/camera-state-select';
import { cameraDriverLabelOf, cameraStateDetailsOf } from '@/components/cameras/cameras';
import { DeleteCameraDialog } from '@/components/cameras/delete-camera-dialog';
import { CopyButton } from '@/components/common/copy-button';
import {
  Fact,
  FactLabel,
  Facts,
  FactValue,
  BackLink,
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
import { DeviceAddresses } from '@/components/devices/device-addresses';
import { networkNameOf } from '@/components/devices/devices';
import { EditDeviceDialog } from '@/components/devices/edit-device-dialog';
import { SubjectHealth } from '@/components/devices/subject-health';
import { deviceSubjectId, type SubjectState } from '@/components/devices/subjects';
import { CTVMoQPreview } from '@/components/streams/ctv-moq-preview';
import { useIsAdministrator, useOrganisationId } from '@/hooks/use-organisation';
import { formatDate, shortPublicId } from '@/lib/format';
import { cameraListQueryOptions } from '@/queries/cameras';
import { networkListQueryOptions } from '@/queries/networks';
import { streamListQueryOptions, subjectStateListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Camera · conservation.tv studio' }];

/**
 * One camera: how it is doing, what it sees through the first stream it feeds, where it is and how it is reached. Its
 * administrators rename and move it, change how it is reached, replace its credentials, change its state, and remove
 * it. The camera is read from the organisation's list, which the cameras page has usually loaded already.
 */
const CameraRoute: FC<Route.ComponentProps> = ({ params }) => {
  const { cameraId } = params;
  const organisationId = useOrganisationId();
  const [cameraQuery, networksQuery, streamsQuery, stateQuery] = useSuspenseQueries({
    queries: [
      {
        ...cameraListQueryOptions(organisationId),
        select: (cameras: Camera[]) => cameras.find(camera => camera.id === cameraId)
      },
      networkListQueryOptions(organisationId),
      {
        ...streamListQueryOptions(organisationId),
        select: (streams: Stream[]) => streams.filter(stream => stream.sourceDeviceId === cameraId)
      },
      {
        ...subjectStateListQueryOptions(organisationId),
        select: (states: SubjectState[]) => states.find(state => state.subjectId === deviceSubjectId(cameraId))
      }
    ]
  });
  const camera = cameraQuery.data;
  if (!camera) return <CameraNotFound />;
  const name = camera.device?.name ?? 'Unnamed camera';
  const streams = streamsQuery.data;
  const first = streams[0];
  return (
    <Page>
      <BackLink to=".." relative="path">
        Cameras
      </BackLink>
      <PageHeader className="-mt-4">
        <PageHeading>
          <div className="flex min-w-0 items-center gap-3">
            <PageTitle className="truncate">{name}</PageTitle>
            <SubjectHealth state={stateQuery.data} />
          </div>
          <PageDescription className="flex items-center gap-2">
            <CameraStateBadge state={camera.state} />
            {cameraStateDetailsOf(camera.state).description}
          </PageDescription>
        </PageHeading>
        <PageActions>
          <PinButton label={name} kind="camera" />
        </PageActions>
      </PageHeader>
      {first && (
        <Section>
          <CTVMoQPreview stream={first.id} />
          <StreamLinks streams={streams} />
        </Section>
      )}
      <CameraFacts camera={camera} networks={networksQuery.data} streams={streams} />
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Reported addresses</SectionTitle>
            <SectionDescription>
              Where the camera last said it can be reached on its network. Most cameras don’t say: they’re reached at
              the address above.
            </SectionDescription>
          </SectionHeading>
        </SectionHeader>
        <DeviceAddresses deviceId={camera.id} />
      </Section>
      <CameraManagement camera={camera} name={name} networks={networksQuery.data} />
    </Page>
  );
};

export default CameraRoute;

/** In place of a camera that isn't in the organisation: deleted, or never there. */
const CameraNotFound: FC = () => {
  return (
    <Page>
      <BackLink to=".." relative="path">
        Cameras
      </BackLink>
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <VideoCameraIcon />
          </EmptyMedia>
          <EmptyTitle>Camera not found</EmptyTitle>
          <EmptyDescription>It may have been deleted, or it belongs to another organisation.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Page>
  );
};

interface StreamLinksProps {
  /** The streams the camera feeds; the preview plays the first. */
  streams: Stream[];
}

/** Under the preview: which stream it plays, and the camera's other streams. */
const StreamLinks: FC<StreamLinksProps> = ({ streams }) => {
  const organisationId = useOrganisationId();
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-custom-12 text-custom-text-secondary">
      {streams.length === 1 ? 'Live from its stream' : 'Live from the first of its streams'}
      {streams.map(stream => (
        <Link
          key={stream.id}
          to={`/organisations/${organisationId}/streams/${stream.id}`}
          className="text-foreground underline-offset-2 hover:underline"
        >
          {stream.name}
        </Link>
      ))}
    </p>
  );
};

interface CameraFactsProps {
  camera: Camera;
  networks: Network[];
  streams: Stream[];
}

/** What the camera is, where it is, and how it is reached. Never its credentials, which are never read back. */
const CameraFacts: FC<CameraFactsProps> = ({ camera, networks, streams }) => {
  const settings = camera.settings;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>About</SectionTitle>
        </SectionHeading>
      </SectionHeader>
      <Facts>
        <Fact>
          <FactLabel>Driver</FactLabel>
          <FactValue>{cameraDriverLabelOf(settings.driver)}</FactValue>
        </Fact>
        {settings.driver === 'axis' ? (
          <>
            <TextFact label="Web address" value={settings.host} />
            <TextFact label="RTSP port" value={String(settings.rtspPort ?? 554)} />
            <TextFact label="Resolutions" value={settings.resolutions.join(', ')} />
          </>
        ) : (
          <TextFact label="Stream URL" value={settings.url} />
        )}
        <TextFact label="Network" value={networkNameOf(networks, camera.device?.networkId ?? null)} />
        <TextFact label="Streams" value={streams.length > 0 ? String(streams.length) : 'None yet'} />
        {camera.device && (
          <>
            <Fact>
              <FactLabel>Public ID</FactLabel>
              <FactValue className="flex items-center gap-1">
                <span className="truncate font-mono text-custom-12" title={camera.device.publicId}>
                  {shortPublicId(camera.device.publicId)}
                </span>
                <CopyButton value={camera.device.publicId} label="Copy public ID" />
              </FactValue>
            </Fact>
            <TextFact label="Added" value={formatDate(camera.device.createdAt)} />
          </>
        )}
      </Facts>
    </Section>
  );
};

interface TextFactProps {
  label: ReactNode;
  /** The value, shown whole on hover where it is cut short. */
  value: string;
}

const TextFact: FC<TextFactProps> = ({ label, value }) => {
  return (
    <Fact>
      <FactLabel>{label}</FactLabel>
      <FactValue title={value}>{value}</FactValue>
    </Fact>
  );
};

interface CameraManagementProps {
  camera: Camera;
  name: string;
  networks: Network[];
}

/** What administrators change about the camera, each beside what it does. Nothing for anyone else. */
const CameraManagement: FC<CameraManagementProps> = ({ camera, name, networks }) => {
  const administrator = useIsAdministrator();
  if (!administrator) return null;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Manage</SectionTitle>
        </SectionHeading>
      </SectionHeader>
      <ItemGroup className="gap-2">
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>Name and network</ItemTitle>
            <ItemDescription>
              {name} · {networkNameOf(networks, camera.device?.networkId ?? null)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {camera.device && (
              <EditDeviceDialog
                device={{ id: camera.id, kind: 'camera', name, networkId: camera.device.networkId }}
                networks={networks}
              />
            )}
          </ItemActions>
        </Item>
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>How it’s reached</ItemTitle>
            <ItemDescription>Its driver, and the address its network’s agent pulls from.</ItemDescription>
          </ItemContent>
          <ItemActions>
            <CameraSettingsDialog camera={camera} name={name} />
          </ItemActions>
        </Item>
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>Credentials</ItemTitle>
            <ItemDescription>
              Kept encrypted and never shown. Replace them, or clear them if it needs none.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <ClearCredentialsDialog cameraId={camera.id} name={name} />
            <ReplaceCredentialsDialog cameraId={camera.id} name={name} />
          </ItemActions>
        </Item>
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>State</ItemTitle>
            <ItemDescription>Only an enabled camera feeds its streams.</ItemDescription>
          </ItemContent>
          <ItemActions className="flex-col items-end">
            <CameraStateSelect camera={camera} name={name} />
          </ItemActions>
        </Item>
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>Delete camera</ItemTitle>
            <ItemDescription>Once no stream starts from it.</ItemDescription>
          </ItemContent>
          <ItemActions>
            <DeleteCameraDialog cameraId={camera.id} name={name} />
          </ItemActions>
        </Item>
      </ItemGroup>
    </Section>
  );
};
