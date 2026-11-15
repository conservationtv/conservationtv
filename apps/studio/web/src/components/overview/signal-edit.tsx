import type { FC, MouseEvent, ReactNode } from 'react';
import {
  ArrowSquareInIcon,
  ArrowsClockwiseIcon,
  CopyIcon,
  DotsSixVerticalIcon,
  DotsThreeIcon,
  EyeIcon,
  LinkIcon,
  NetworkIcon,
  PlusIcon,
  TiktokLogoIcon,
  TrashIcon,
  TwitchLogoIcon,
  VideoCameraIcon,
  XIcon,
  YoutubeLogoIcon
} from '@phosphor-icons/react';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@conservationtv/ui/components/card';
import { Checkbox } from '@conservationtv/ui/components/checkbox';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@conservationtv/ui/components/field';
import { Input } from '@conservationtv/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@conservationtv/ui/components/input-group';
import { Kbd } from '@conservationtv/ui/components/kbd';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { RadioGroup, RadioGroupItem } from '@conservationtv/ui/components/radio-group';
import { Separator } from '@conservationtv/ui/components/separator';
import { Spinner } from '@conservationtv/ui/components/spinner';
import { Switch } from '@conservationtv/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@conservationtv/ui/components/toggle-group';
import { cn } from '@conservationtv/ui/lib/utils';

import { SignalHealthDot, SignalNodeRow, SignalNodeRows, type SignalStatus } from '@/components/overview/signal-map';
import { NETWORKS, sourceIcons, type SampleSource } from '@/components/overview/signal-samples';

// The signal map's editing parts, whatever lays the map out: a panel (floated beside a node on the graph, or opened in
// place in the stack), the forms that go in it, and the small controls on rows and wires. Made-up values; nothing
// saves.

// ---------------------------------------------------------------------------------------------------------------------
// The panel.

export interface EditPanelProps {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** Floated beside what it edits, or opened in place inside it. */
  variant?: 'floating' | 'inline';
  className?: string;
  children: ReactNode;
}

/** A titled form with its actions at the foot. */
export const EditPanel: FC<EditPanelProps> = ({ title, description, footer, variant = 'floating', className, children }) => {
  if (variant === 'inline') {
    return (
      <div className={cn('flex flex-col gap-3 border-t border-border pt-3 text-custom-13 whitespace-normal', className)}>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{title}</span>
          {description && <span className="text-custom-12 text-muted-foreground">{description}</span>}
        </div>
        {children}
        {footer && <div className="flex items-center justify-end gap-2 pt-1">{footer}</div>}
      </div>
    );
  }
  return (
    <Card size="sm" className={cn('w-80 text-custom-13 shadow-lg', className)}>
      <CardHeader>
        <CardTitle className="text-custom-13">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer && <CardFooter className="justify-end gap-2 border-t">{footer}</CardFooter>}
    </Card>
  );
};

/** Cancel and the panel's action; something destructive, or a way out, at the start. */
export const EditFooter: FC<{ action: string; start?: ReactNode }> = ({ action, start }) => (
  <>
    {start && <span className="mr-auto">{start}</span>}
    <Button variant="ghost" size="sm">
      Cancel
    </Button>
    <Button size="sm">{action}</Button>
  </>
);

export const RemoveButton: FC<{ disabled?: boolean }> = ({ disabled }) => (
  <Button variant="ghost" size="sm" className="text-destructive" disabled={disabled}>
    <TrashIcon />
    Remove
  </Button>
);

// ---------------------------------------------------------------------------------------------------------------------
// Small controls.

export const MoreButton: FC<{ onClick?: (event: MouseEvent<HTMLButtonElement>) => void }> = ({ onClick }) => (
  <Button variant="ghost" size="icon-xs" aria-label="More" onClick={onClick}>
    <DotsThreeIcon weight="bold" />
  </Button>
);

/** A dashed "add" at a column's or a list's foot. */
export const AddPlaceholder: FC<{ active?: boolean; className?: string; onClick?: () => void; children: ReactNode }> = ({
  active,
  className,
  onClick,
  children
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 text-left text-custom-13 text-muted-foreground [&_svg]:size-4',
      active && 'border-solid border-ring bg-muted text-foreground',
      className
    )}
  >
    <PlusIcon />
    {children}
  </button>
);

/** A quiet "add" inside a list. */
export const AddRow: FC<{ children: ReactNode }> = ({ children }) => (
  <button
    type="button"
    className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-custom-12 text-muted-foreground hover:bg-muted [&_svg]:size-3.5"
  >
    <PlusIcon />
    {children}
  </button>
);

export const ChangeBadge: FC<{ children: ReactNode; tone?: 'new' | 'edit' | 'remove' }> = ({ children, tone = 'edit' }) => (
  <Badge
    variant={tone === 'remove' ? 'destructive' : 'secondary'}
    className={cn(tone === 'new' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400')}
  >
    {children}
  </Badge>
);

export const UnwireButton: FC = () => (
  <Button variant="outline" size="icon-xs" className="rounded-full bg-background" aria-label="Disconnect">
    <XIcon />
  </Button>
);

/** A member of an opened group while editing: a grip, its dot, picked when its panel is open. */
export const EditRow: FC<{ source: SampleSource; picked?: boolean; status?: SignalStatus; meta?: ReactNode }> = ({
  source,
  picked,
  status,
  meta
}) => (
  <SignalNodeRow className={cn('-mx-1.5 rounded-md px-1.5 py-0.5', picked && 'bg-muted ring-1 ring-ring')}>
    <DotsSixVerticalIcon className="!size-3 cursor-grab" />
    {sourceIcons[source.kind]}
    <span className="flex flex-1 flex-col">
      {source.name}
      {meta}
    </span>
    <SignalHealthDot status={status ?? source.status} />
  </SignalNodeRow>
);

export const EditRows: FC<{ sources: SampleSource[]; picked?: string; children?: ReactNode }> = ({
  sources,
  picked,
  children
}) => (
  <SignalNodeRows>
    {sources.map(source => (
      <EditRow key={source.id} source={source} picked={source.id === picked} />
    ))}
    {children}
  </SignalNodeRows>
);

export const Connecting: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="flex items-center gap-1 text-custom-11 text-muted-foreground">
    <Spinner className="size-3" />
    {children}
  </span>
);

// ---------------------------------------------------------------------------------------------------------------------
// Adding sources.

const MenuItem: FC<{ icon: ReactNode; title: string; description: string; children?: ReactNode }> = ({
  icon,
  title,
  description,
  children
}) => (
  <div className="flex flex-col gap-1.5 rounded-md p-2 hover:bg-muted">
    <div className="flex items-start gap-2.5 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
      {icon}
      <div className="flex flex-col gap-0.5">
        <span className="text-custom-13 font-medium">{title}</span>
        <span className="text-custom-12 text-muted-foreground">{description}</span>
      </div>
    </div>
    {children}
  </div>
);

/** What kind of source: a camera on a network, a new network, an ingest. */
export const AddSourceMenu: FC<{ className?: string }> = ({ className }) => (
  <div className={cn('flex flex-col gap-0.5 text-popover-foreground whitespace-normal', className)}>
    <MenuItem icon={<VideoCameraIcon />} title="Camera" description="On a network an agent already serves">
      <div className="ml-6.5 flex flex-wrap gap-1">
        {NETWORKS.map(network => (
          <Badge key={network.id} variant="outline">
            {network.name}
          </Badge>
        ))}
      </div>
    </MenuItem>
    <MenuItem icon={<NetworkIcon />} title="Network" description="Somewhere new: install an agent on a machine there" />
    <MenuItem icon={<ArrowSquareInIcon />} title="Ingest" description="Pushed from OBS or a phone over RTMP, from anywhere" />
  </div>
);

/** What a network's agent can see there, one click each; or an address by hand. */
export const FoundCameras: FC<{ agent: string }> = ({ agent }) => (
  <div className="flex flex-col gap-1.5 border-t border-border pt-2 whitespace-normal">
    <Connecting>Found on this network by {agent}</Connecting>
    {[
      ['Axis M3088', '10.0.3.41'],
      ['Reolink RLC-811', '10.0.3.57']
    ].map(([model, address]) => (
      <div key={address} className="flex items-center gap-2 text-custom-12">
        <VideoCameraIcon className="size-3.5 text-muted-foreground" />
        <span className="flex flex-1 flex-col">
          {model}
          <span className="text-custom-11 text-muted-foreground">{address}</span>
        </span>
        <Button variant="outline" size="xs">
          Add
        </Button>
      </div>
    ))}
    <AddRow>Add by address</AddRow>
  </div>
);

const FeedChecks: FC<{ prefix: string; full?: boolean; social?: boolean }> = ({ prefix, full, social }) => (
  <FieldSet>
    <FieldLegend variant="label">Feeds</FieldLegend>
    <Field orientation="horizontal">
      <Checkbox id={`${prefix}-full`} defaultChecked={full} />
      <FieldLabel htmlFor={`${prefix}-full`}>Full broadcast</FieldLabel>
    </Field>
    <Field orientation="horizontal">
      <Checkbox id={`${prefix}-social`} defaultChecked={social} />
      <FieldLabel htmlFor={`${prefix}-social`}>Social media broadcast</FieldLabel>
    </Field>
  </FieldSet>
);

/** A found camera's details: its name, its credentials, the broadcasts it feeds. */
export const CameraFields: FC<{ prefix: string }> = ({ prefix }) => (
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
    <FeedChecks prefix={prefix} full />
  </FieldGroup>
);

/** The one command that installs a new network's agent. */
export const InstallCommand: FC<{ where: string; className?: string }> = ({ where, className }) => (
  <div className={cn('flex flex-col gap-2 border-t border-border pt-2 text-custom-12 whitespace-normal', className)}>
    <span className="text-muted-foreground">On a machine in the {where}, run:</span>
    <InputGroup>
      <InputGroupInput readOnly value="curl -fsSL ctv.sh/agent | sh -s ab3f-91" className="font-mono text-custom-11" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label="Copy">
          <CopyIcon />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
    <span className="text-custom-11 text-muted-foreground">Cameras it finds appear here.</span>
  </div>
);

const CopyField: FC<{ id: string; label: string; value: string; secret?: boolean }> = ({ id, label, value, secret }) => (
  <Field>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <InputGroup>
      <InputGroupInput id={id} readOnly type={secret ? 'password' : 'text'} value={value} className="font-mono text-custom-11" />
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

/** A new ingest's address and key, to paste into OBS or a phone. */
export const IngestKeys: FC<{ prefix: string }> = ({ prefix }) => (
  <FieldGroup className="gap-3">
    <CopyField id={`${prefix}-url`} label="Server" value="rtmp://in.conservation.tv/live" />
    <CopyField id={`${prefix}-key`} label="Stream key" value="sk_live_8f2a91c0" secret />
    <FieldDescription>Anyone with the key can push here. Make a new one if it leaks.</FieldDescription>
  </FieldGroup>
);

// ---------------------------------------------------------------------------------------------------------------------
// Editing.

/** A network's agents: one active, any others on standby. */
export const NetworkFields: FC<{ prefix: string }> = ({ prefix }) => (
  <FieldGroup className="gap-4">
    <FieldSet>
      <FieldLegend variant="label">Agents</FieldLegend>
      <RadioGroup defaultValue="pi-04" className="gap-2">
        {[
          ['pi-04', 'Active · up 12 days'],
          ['pi-04b', 'Standby · takes over if pi-04 stops']
        ].map(([agent, note]) => (
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

export const ReplaceDevice: FC<{ device: string }> = ({ device }) => (
  <span className="flex items-center gap-1.5">
    {device}
    <Button variant="link" size="xs" className="h-auto p-0">
      <ArrowsClockwiseIcon />
      Replace
    </Button>
  </span>
);

/** A camera's name, feeds and network. */
export const CameraEditFields: FC<{ prefix: string; name?: string; network?: string; social?: boolean }> = ({
  prefix,
  name = 'Serval (west)',
  network = 'main',
  social = true
}) => (
  <FieldGroup className="gap-4">
    <Field>
      <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
      <Input id={`${prefix}-name`} defaultValue={name} />
    </Field>
    <FeedChecks prefix={prefix} full social={social} />
    <Field>
      <FieldLabel htmlFor={`${prefix}-network`}>Network</FieldLabel>
      <NativeSelect id={`${prefix}-network`} defaultValue={network}>
        {NETWORKS.map(network => (
          <NativeSelectOption key={network.id} value={network.id}>
            {network.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  </FieldGroup>
);

/** A broadcast's name, shape, renderer and recording. */
export const BroadcastFields: FC<{ prefix: string; name?: string; portrait?: boolean; recording?: boolean }> = ({
  prefix,
  name = 'Full broadcast',
  portrait = false,
  recording = true
}) => (
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

const platforms = [
  { id: 'twitch', name: 'Twitch', icon: <TwitchLogoIcon weight="fill" /> },
  { id: 'youtube', name: 'YouTube', icon: <YoutubeLogoIcon weight="fill" /> },
  { id: 'tiktok', name: 'TikTok', icon: <TiktokLogoIcon weight="fill" /> },
  { id: 'rtmp', name: 'Other (RTMP)', icon: <LinkIcon /> }
];

/** A new channel: its platform, then a sign-in or a pasted stream key. */
export const ChannelFields: FC = () => (
  <FieldGroup className="gap-4">
    <div className="grid grid-cols-2 gap-1.5">
      {platforms.map(platform => (
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
