import type { FC } from 'react';
import { ArrowSquareInIcon, NetworkIcon, VideoCameraIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { Field, FieldGroup, FieldLabel } from '@conservationtv/ui/components/field';
import { Input } from '@conservationtv/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { Switch } from '@conservationtv/ui/components/switch';

import {
  BroadcastFields,
  CameraFields,
  ChannelFields,
  Choice,
  Connecting,
  IngestKeys,
  InstallCommand,
  NetworkFields,
  NewCameraFields,
  ReplaceDevice
} from '@/components/signal/editing/signal-edit-fields';
import {
  SignalFormBody,
  SignalFormCancel,
  SignalFormDescription,
  SignalFormFooter,
  SignalFormHeader,
  SignalFormRemove,
  SignalFormSubmit,
  SignalFormTitle,
  SignalFormWaiting
} from '@/components/signal/editing/signal-edit-surface';
import {
  useSignalEditingStore,
  useSignalFormTarget,
  type SignalTarget
} from '@/components/signal/editing/signal-editing-store';
import { useSignalSystem } from '@/components/signal/signal-context';
import { PLATFORM_NAMES } from '@/components/signal/signal-system';

// The signal's forms, one for each thing that can be edited or added. Made-up values; nothing saves.

interface ExistingProps {
  id: string;
}

/** Save, Cancel and Remove: the foot of a form for something there already is. */
const SaveFooter: FC = () => {
  return (
    <SignalFormFooter>
      <SignalFormRemove />
      <SignalFormCancel />
      <SignalFormSubmit>Save</SignalFormSubmit>
    </SignalFormFooter>
  );
};

const ChannelForm: FC<ExistingProps> = ({ id }) => {
  const system = useSignalSystem();
  const channel = system.channels.find(each => each.id === id);
  if (!channel) return null;
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>{channel.handle}</SignalFormTitle>
        <SignalFormDescription>{PLATFORM_NAMES[channel.platform]} channel</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="channel-broadcast">Sends</FieldLabel>
            <NativeSelect id="channel-broadcast" defaultValue={channel.broadcast}>
              {system.broadcasts.map(broadcast => (
                <NativeSelectOption key={broadcast.id} value={broadcast.id}>
                  {broadcast.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field orientation="horizontal" className="justify-between">
            <FieldLabel htmlFor="channel-on">Going out</FieldLabel>
            <Switch id="channel-on" defaultChecked={!channel.off} />
          </Field>
        </FieldGroup>
      </SignalFormBody>
      <SaveFooter />
    </>
  );
};

const AddChannelForm: FC = () => {
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>Add a channel</SignalFormTitle>
        <SignalFormDescription>Where a broadcast goes out to.</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <ChannelFields />
      </SignalFormBody>
      <SignalFormFooter>
        <SignalFormCancel />
        <SignalFormSubmit>Connect</SignalFormSubmit>
      </SignalFormFooter>
    </>
  );
};

const BroadcastForm: FC<ExistingProps> = ({ id }) => {
  const system = useSignalSystem();
  const broadcast = system.broadcasts.find(each => each.id === id);
  if (!broadcast) return null;
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>{broadcast.name}</SignalFormTitle>
        <SignalFormDescription>
          {`${String(broadcast.width)}×${String(broadcast.height)} · ${broadcast.agent}`}
        </SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <BroadcastFields
          prefix="broadcast"
          name={broadcast.name}
          portrait={broadcast.height > broadcast.width}
          recording={broadcast.recording}
        />
      </SignalFormBody>
      <SaveFooter />
    </>
  );
};

const AddBroadcastForm: FC = () => {
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>New broadcast</SignalFormTitle>
        <SignalFormDescription>A programme, composed from the sources, sent to channels.</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <BroadcastFields prefix="new-broadcast" name="" portrait={false} recording={false} />
      </SignalFormBody>
      <SignalFormFooter>
        <SignalFormCancel />
        <SignalFormSubmit>Create</SignalFormSubmit>
      </SignalFormFooter>
    </>
  );
};

const NetworkForm: FC<ExistingProps> = ({ id }) => {
  const system = useSignalSystem();
  const network = system.networks.find(each => each.id === id);
  if (!network) return null;
  const count = system.cameras.filter(camera => camera.network === id).length;
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>Edit network</SignalFormTitle>
        <SignalFormDescription>{`${String(count)} cameras · ${network.agent}`}</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="network-name">Name</FieldLabel>
            <Input id="network-name" defaultValue={network.name} />
          </Field>
          <NetworkFields prefix="network" />
        </FieldGroup>
      </SignalFormBody>
      <SaveFooter />
    </>
  );
};

const SubgroupForm: FC<ExistingProps> = ({ id }) => {
  const system = useSignalSystem();
  const subgroup = system.subgroups.find(each => each.id === id);
  if (!subgroup) return null;
  const network = system.networks.find(each => each.id === subgroup.network);
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>Edit group</SignalFormTitle>
        <SignalFormDescription>
          {`${String(subgroup.cameras.length)} cameras · in ${network?.name ?? 'its network'}`}
        </SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="subgroup-name">Name</FieldLabel>
            <Input id="subgroup-name" defaultValue={subgroup.name} />
          </Field>
          <p className="text-custom-12 text-muted-foreground">
            A group only keeps a network’s cameras in order. Removing it leaves its cameras in the network.
          </p>
        </FieldGroup>
      </SignalFormBody>
      <SaveFooter />
    </>
  );
};

const CameraForm: FC<ExistingProps> = ({ id }) => {
  const system = useSignalSystem();
  const camera = system.cameras.find(each => each.id === id);
  if (!camera) return null;
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>Edit camera</SignalFormTitle>
        <SignalFormDescription>
          <ReplaceDevice device={camera.device} />
        </SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <CameraFields prefix="camera" name={camera.name} network={camera.network} feeds={camera.feeds} />
      </SignalFormBody>
      <SaveFooter />
    </>
  );
};

const IngestForm: FC<ExistingProps> = ({ id }) => {
  const system = useSignalSystem();
  const ingest = system.ingests.find(each => each.id === id);
  if (!ingest) return null;
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>{ingest.name}</SignalFormTitle>
        <SignalFormDescription>{ingest.device}</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="ingest-name">Name</FieldLabel>
            <Input id="ingest-name" defaultValue={ingest.name} />
          </Field>
          <IngestKeys prefix="ingest" />
        </FieldGroup>
      </SignalFormBody>
      <SaveFooter />
    </>
  );
};

/** What kind of source to add; choosing goes on to that kind's form. */
const AddSourceForm: FC = () => {
  const system = useSignalSystem();
  const store = useSignalEditingStore();
  const go = (target: SignalTarget) => store?.trigger.edit({ target });
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>Add a source</SignalFormTitle>
        <SignalFormDescription>What’s sending it?</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <div className="flex flex-col gap-2">
          <Choice icon={<VideoCameraIcon />} title="Camera" description="On a network an agent already serves">
            <div className="ml-6.5 flex flex-wrap gap-1">
              {system.networks.map(network => (
                <Button
                  key={network.id}
                  variant="outline"
                  size="xs"
                  onClick={() => go({ kind: 'add-camera', network: network.id })}
                >
                  {network.name}
                </Button>
              ))}
            </div>
          </Choice>
          <Choice
            icon={<NetworkIcon />}
            title="Network"
            description="Somewhere new: install an agent on a machine there"
            onClick={() => go({ kind: 'add-network' })}
          />
          <Choice
            icon={<ArrowSquareInIcon />}
            title="Ingest"
            description="Pushed from OBS or a phone over RTMP, from anywhere"
            onClick={() => go({ kind: 'add-ingest' })}
          />
        </div>
      </SignalFormBody>
    </>
  );
};

interface AddCameraFormProps {
  network: string;
}

/** A camera its network's agent has found, to name and add. */
const AddCameraForm: FC<AddCameraFormProps> = ({ network: id }) => {
  const system = useSignalSystem();
  const network = system.networks.find(each => each.id === id);
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>{`New camera on ${network?.name ?? 'a network'}`}</SignalFormTitle>
        <SignalFormDescription>
          {`Axis M3088 at 10.0.3.41, found by ${network?.agent ?? 'its agent'}.`}
        </SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <NewCameraFields prefix="new-camera" />
      </SignalFormBody>
      <SignalFormFooter>
        <SignalFormCancel />
        <SignalFormSubmit>Add camera</SignalFormSubmit>
      </SignalFormFooter>
    </>
  );
};

const AddNetworkForm: FC = () => {
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>New network</SignalFormTitle>
        <SignalFormDescription>Somewhere with cameras: an agent there finds them.</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="new-network-name">Name</FieldLabel>
            <Input id="new-network-name" defaultValue="Hospital wing" />
          </Field>
          <InstallCommand where="hospital wing" className="border-t-0 pt-0" />
        </FieldGroup>
      </SignalFormBody>
      <SignalFormFooter>
        <SignalFormWaiting>
          <Connecting>Waiting for its agent</Connecting>
        </SignalFormWaiting>
        <SignalFormSubmit>Done</SignalFormSubmit>
      </SignalFormFooter>
    </>
  );
};

const AddIngestForm: FC = () => {
  return (
    <>
      <SignalFormHeader>
        <SignalFormTitle>New ingest</SignalFormTitle>
        <SignalFormDescription>Paste these into OBS, or a phone’s streaming app.</SignalFormDescription>
      </SignalFormHeader>
      <SignalFormBody>
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="new-ingest-name">Name</FieldLabel>
            <Input id="new-ingest-name" defaultValue="Keeper’s phone" />
          </Field>
          <IngestKeys prefix="new-ingest" />
        </FieldGroup>
      </SignalFormBody>
      <SignalFormFooter>
        <SignalFormCancel />
        <SignalFormSubmit>Done</SignalFormSubmit>
      </SignalFormFooter>
    </>
  );
};

interface FormForProps {
  target: SignalTarget;
}

/** The form for a thing there already is, by what it is. */
const ExistingForm: FC<FormForProps> = ({ target }) => {
  switch (target.kind) {
    case 'channel':
      return <ChannelForm id={target.id} />;
    case 'broadcast':
      return <BroadcastForm id={target.id} />;
    case 'network':
      return <NetworkForm id={target.id} />;
    case 'subgroup':
      return <SubgroupForm id={target.id} />;
    case 'camera':
      return <CameraForm id={target.id} />;
    case 'ingest':
      return <IngestForm id={target.id} />;
    default:
      return null;
  }
};

/** The form for something to add, by what it is. */
const NewForm: FC<FormForProps> = ({ target }) => {
  switch (target.kind) {
    case 'add-channel':
      return <AddChannelForm />;
    case 'add-broadcast':
      return <AddBroadcastForm />;
    case 'add-source':
      return <AddSourceForm />;
    case 'add-camera':
      return <AddCameraForm network={target.network} />;
    case 'add-network':
      return <AddNetworkForm />;
    case 'add-ingest':
      return <AddIngestForm />;
    default:
      return null;
  }
};

/** The form for whatever has been taken up to edit or add. Put it in a SignalEditSurface, which says what that is. */
export const SignalEditForms: FC = () => {
  const target = useSignalFormTarget();
  if (target === null) return null;
  return 'id' in target ? <ExistingForm target={target} /> : <NewForm target={target} />;
};
