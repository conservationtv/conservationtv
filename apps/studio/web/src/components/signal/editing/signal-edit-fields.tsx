import type { FC, ReactNode } from 'react';
import {
  ArrowsClockwiseIcon,
  CopyIcon,
  EyeIcon,
  LinkIcon,
  PlusIcon,
  TiktokLogoIcon,
  TwitchLogoIcon,
  YoutubeLogoIcon
} from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { Checkbox } from '@conservationtv/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet
} from '@conservationtv/ui/components/field';
import { Input } from '@conservationtv/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@conservationtv/ui/components/input-group';
import { Kbd } from '@conservationtv/ui/components/kbd';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { RadioGroup, RadioGroupItem } from '@conservationtv/ui/components/radio-group';
import { Separator } from '@conservationtv/ui/components/separator';
import { Spinner } from '@conservationtv/ui/components/spinner';
import { Switch } from '@conservationtv/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@conservationtv/ui/components/toggle-group';
import { cn } from '@conservationtv/ui/lib/utils';

import { useSignalSystem } from '@/components/signal/signal-context';
import { SignalHealthDot } from '@/components/signal/signal-node';

// What goes in the signal's forms: the fields for each kind of thing, and the small pieces they share. Made-up values;
// nothing saves.

export interface ChoiceProps {
  icon: ReactNode;
  title: string;
  description: string;
  /** Pressing the whole of it chooses it; without, it only holds its children's choices. */
  onClick?: () => void;
  children?: ReactNode;
}

/** A big, plain choice: what kind of source to add. */
export const Choice: FC<ChoiceProps> = ({ icon, title, description, onClick, children }) => {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <button
        type="button"
        onClick={onClick}
        disabled={onClick === undefined}
        className="flex items-start gap-2.5 text-left enabled:cursor-pointer [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
      >
        {icon}
        <span className="flex flex-col gap-0.5">
          <span className="text-custom-13 font-medium">{title}</span>
          <span className="text-custom-12 text-muted-foreground">{description}</span>
        </span>
      </button>
      {children}
    </div>
  );
};

interface AddRowProps {
  children: ReactNode;
}

/** A quiet "add" inside a list. */
const AddRow: FC<AddRowProps> = ({ children }) => {
  return (
    <button
      type="button"
      className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-custom-12 text-muted-foreground hover:bg-muted [&_svg]:size-3.5"
    >
      <PlusIcon />
      {children}
    </button>
  );
};

export interface ConnectingProps {
  children: ReactNode;
}

/** Something being waited for. */
export const Connecting: FC<ConnectingProps> = ({ children }) => {
  return (
    <span className="flex items-center gap-1 text-custom-11 text-muted-foreground">
      <Spinner className="size-3" />
      {children}
    </span>
  );
};

interface FeedChecksProps {
  prefix: string;
  /** The broadcasts it feeds. */
  feeds: string[];
}

/** Which broadcasts a source feeds. */
const FeedChecks: FC<FeedChecksProps> = ({ prefix, feeds }) => {
  const system = useSignalSystem();
  return (
    <FieldSet>
      <FieldLegend variant="label">Feeds</FieldLegend>
      {system.broadcasts.map(broadcast => (
        <Field key={broadcast.id} orientation="horizontal">
          <Checkbox id={`${prefix}-${broadcast.id}`} defaultChecked={feeds.includes(broadcast.id)} />
          <FieldLabel htmlFor={`${prefix}-${broadcast.id}`}>{broadcast.name}</FieldLabel>
        </Field>
      ))}
    </FieldSet>
  );
};

export interface NewCameraFieldsProps {
  prefix: string;
}

/** A found camera's details: its name, its credentials, the broadcasts it feeds. */
export const NewCameraFields: FC<NewCameraFieldsProps> = ({ prefix }) => {
  const system = useSignalSystem();
  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
        <Input id={`${prefix}-name`} defaultValue="Otter pool" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`${prefix}-user`}>Username</FieldLabel>
          <Input id={`${prefix}-user`} defaultValue="root" />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-password`}>Password</FieldLabel>
          <Input id={`${prefix}-password`} type="password" defaultValue="hunter22" />
        </Field>
      </div>
      {/* A new camera feeds the first broadcast until told otherwise. */}
      <FeedChecks prefix={prefix} feeds={system.broadcasts.slice(0, 1).map(broadcast => broadcast.id)} />
    </FieldGroup>
  );
};

export interface InstallCommandProps {
  where: string;
  className?: string;
}

/** The one command that installs a new network's agent. */
export const InstallCommand: FC<InstallCommandProps> = ({ where, className }) => {
  return (
    <div className={cn('flex flex-col gap-2 border-t border-border pt-2 text-custom-12 whitespace-normal', className)}>
      <span className="text-muted-foreground">On a machine in the {where}, run:</span>
      <InputGroup>
        <InputGroupInput
          readOnly
          value="curl -fsSL ctv.sh/agent | sh -s ab3f-91"
          className="font-mono text-custom-11"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Copy">
            <CopyIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span className="text-custom-11 text-muted-foreground">Cameras it finds appear here.</span>
    </div>
  );
};

interface CopyFieldProps {
  id: string;
  label: string;
  value: string;
  secret?: boolean;
}

const CopyField: FC<CopyFieldProps> = ({ id, label, value, secret }) => {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          readOnly
          type={secret ? 'password' : 'text'}
          value={value}
          className="font-mono text-custom-11"
        />
        <InputGroupAddon align="inline-end">
          {secret && (
            <InputGroupButton size="icon-xs" aria-label="Show">
              <EyeIcon />
            </InputGroupButton>
          )}
          <InputGroupButton size="icon-xs" aria-label="Copy">
            <CopyIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
};

export interface IngestKeysProps {
  prefix: string;
}

/** An ingest's address and key, to paste into OBS or a phone. */
export const IngestKeys: FC<IngestKeysProps> = ({ prefix }) => {
  return (
    <FieldGroup className="gap-3">
      <CopyField id={`${prefix}-url`} label="Server" value="rtmp://in.conservation.tv/live" />
      <CopyField id={`${prefix}-key`} label="Stream key" value="sk_live_8f2a91c0" secret />
      <FieldDescription>Anyone with the key can push here. Make a new one if it leaks.</FieldDescription>
    </FieldGroup>
  );
};

const AGENTS = [
  ['pi-04', 'Active · up 12 days'],
  ['pi-04b', 'Standby · takes over if pi-04 stops']
];

export interface NetworkFieldsProps {
  prefix: string;
}

/** A network's agents: one active, any others on standby. */
export const NetworkFields: FC<NetworkFieldsProps> = ({ prefix }) => {
  return (
    <FieldGroup className="gap-4">
      <FieldSet>
        <FieldLegend variant="label">Agents</FieldLegend>
        <RadioGroup defaultValue="pi-04" className="gap-2">
          {AGENTS.map(([agent, note]) => (
            <Field key={agent} orientation="horizontal">
              <RadioGroupItem value={agent} id={`${prefix}-${agent}`} />
              <FieldLabel htmlFor={`${prefix}-${agent}`} className="flex flex-1 flex-col items-start gap-0">
                <span className="flex items-center gap-1.5">
                  {agent}
                  <SignalHealthDot status="ok" />
                </span>
                <span className="font-normal text-muted-foreground">{note}</span>
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
        <AddRow>Add a standby agent</AddRow>
      </FieldSet>
      <FieldDescription>Move or remove its cameras before removing the network.</FieldDescription>
    </FieldGroup>
  );
};

export interface ReplaceDeviceProps {
  device: string;
}

/** The device behind a camera, and a way to swap it for another. */
export const ReplaceDevice: FC<ReplaceDeviceProps> = ({ device }) => {
  return (
    <span className="flex items-center gap-1.5">
      {device}
      <Button variant="link" size="xs" className="h-auto p-0">
        <ArrowsClockwiseIcon />
        Replace
      </Button>
    </span>
  );
};

export interface CameraFieldsProps {
  prefix: string;
  name: string;
  network: string | undefined;
  feeds: string[];
}

/** A camera's name, feeds and network. */
export const CameraFields: FC<CameraFieldsProps> = ({ prefix, name, network, feeds }) => {
  const system = useSignalSystem();
  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
        <Input id={`${prefix}-name`} defaultValue={name} />
      </Field>
      <FeedChecks prefix={prefix} feeds={feeds} />
      <Field>
        <FieldLabel htmlFor={`${prefix}-network`}>Network</FieldLabel>
        <NativeSelect id={`${prefix}-network`} defaultValue={network}>
          {system.networks.map(each => (
            <NativeSelectOption key={each.id} value={each.id}>
              {each.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </FieldGroup>
  );
};

export interface BroadcastFieldsProps {
  prefix: string;
  name: string;
  portrait: boolean;
  recording: boolean;
}

/** A broadcast's name, frame, renderer and recording. */
export const BroadcastFields: FC<BroadcastFieldsProps> = ({ prefix, name, portrait, recording }) => {
  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
        <Input id={`${prefix}-name`} defaultValue={name} placeholder="Broadcast name" />
      </Field>
      <Field>
        <FieldLabel>Shape</FieldLabel>
        <ToggleGroup
          variant="outline"
          size="sm"
          defaultValue={[portrait ? 'portrait' : 'landscape']}
          className="w-full"
        >
          <ToggleGroupItem value="landscape" className="flex-1 data-[pressed]:bg-muted data-[pressed]:font-medium">
            Landscape 1920×1080
          </ToggleGroupItem>
          <ToggleGroupItem value="portrait" className="flex-1 data-[pressed]:bg-muted data-[pressed]:font-medium">
            Portrait 1080×1920
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-agent`}>Rendered by</FieldLabel>
        <NativeSelect id={`${prefix}-agent`} defaultValue="windows">
          <NativeSelectOption value="windows">Windows OBS agent</NativeSelectOption>
          <NativeSelectOption value="cloud">Cloud renderer</NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field orientation="horizontal" className="justify-between">
        <FieldLabel htmlFor={`${prefix}-recording`}>Record to disk</FieldLabel>
        <Switch id={`${prefix}-recording`} defaultChecked={recording} />
      </Field>
    </FieldGroup>
  );
};

const PLATFORMS = [
  { id: 'twitch', name: 'Twitch', icon: <TwitchLogoIcon weight="fill" /> },
  { id: 'youtube', name: 'YouTube', icon: <YoutubeLogoIcon weight="fill" /> },
  { id: 'tiktok', name: 'TikTok', icon: <TiktokLogoIcon weight="fill" /> },
  { id: 'rtmp', name: 'Other (RTMP)', icon: <LinkIcon /> }
];

/** A new channel: its platform, then a sign-in or a pasted stream key. */
export const ChannelFields: FC = () => {
  return (
    <FieldGroup className="gap-4">
      <div className="grid grid-cols-2 gap-1.5">
        {PLATFORMS.map(platform => (
          <button
            key={platform.id}
            type="button"
            className={cn(
              'flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-custom-12 [&_svg]:size-4',
              platform.id === 'youtube' && 'border-ring bg-muted ring-1 ring-ring'
            )}
          >
            {platform.icon}
            {platform.name}
          </button>
        ))}
      </div>
      <Button variant="outline" size="sm" className="w-full">
        <YoutubeLogoIcon weight="fill" />
        Sign in with YouTube
      </Button>
      <div className="flex items-center gap-2 text-custom-11 text-muted-foreground">
        <Separator className="flex-1" />
        or paste a stream key
        <Separator className="flex-1" />
      </div>
      <Field>
        <InputGroup>
          <InputGroupInput type="password" placeholder="xxxx-xxxx-xxxx-xxxx" />
          <InputGroupAddon align="inline-end">
            <Kbd>⌘V</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <FieldDescription>Kept apart from everything else; only the output agent reads it.</FieldDescription>
      </Field>
    </FieldGroup>
  );
};
