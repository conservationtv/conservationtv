import { Suspense, startTransition, useState, type FC, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ArrowSquareOutIcon, CheckIcon, CopyIcon, GlobeSimpleIcon, KeyIcon, WarningIcon } from '@phosphor-icons/react';
import type { Rendition } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import { buttonVariants } from '@conservationtv/ui/lib/button-variants';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@conservationtv/ui/components/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@conservationtv/ui/components/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@conservationtv/ui/components/input-group';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';

import { GATEWAY_PROTOCOLS } from '@/components/gateways/gateways';
import {
  ReadRow,
  ReadRowActions,
  ReadRowHeading,
  ReadRowNote,
  ReadRows,
  ReadRowTitle,
  RenditionTabs
} from '@/components/streams/read-parts';
import { RENDITIONS } from '@/components/streams/renditions';
import { formatDateTime } from '@/lib/format';
import { useCopy } from '@/hooks/use-copy';
import type { ProtocolRead, ProtocolReadable, ProtocolReadQueryOptions } from '@/queries/streams';

// How a reader on the network reads something at its MediaMTX gateway: a stream's delivery, or a show's preview. Every
// address needs a read token from the studio (apps/agent/core/src/runtimes/mediamtx/auth.ts): MediaMTX admits anyone else only with one, signed for that
// gateway, path and action. Each protocol is offered at the gateway's hostname and at the IP it points at (the agent's
// preferred address), for a reader whose DNS doesn't resolve the name. Where the token can ride in the URL (`?jwt=`),
// pressing a variant copies the whole working URL; WebRTC's WHEP is given as a URL and a bearer header, in a dialog.

/** The gateway's hostname, and the address its DNS record points at: the agent's preferred one. */
export interface GatewayName {
  hostname: string;
  address: string | null;
}

/**
 * The query for how this account reads one rendition by one protocol: `exposureReadQueryOptions` for a stream's
 * delivery, `previewReadQueryOptions` for a show's preview.
 */
export type ProtocolReadOf = (protocol: string, rendition: Rendition) => ProtocolReadQueryOptions;

export interface LocalReadProps {
  /** How each protocol's connection is asked for, by rendition. */
  read: ProtocolReadOf;
  /** The renditions it offers, each read at its own address. */
  renditions: Rendition[];
  /** The gateway's hostname, once it has one: each protocol is then offered there and at the IP it points at. */
  name: GatewayName | null;
}

/** Each rendition it offers as a compact tab, each listing the protocols a reader can use for it. */
export const LocalRead: FC<LocalReadProps> = ({ read, renditions, name }) => {
  const offered = RENDITIONS.filter(rendition => renditions.includes(rendition));
  // The tab moves as soon as it is chosen; the rows change in a transition, so they keep showing the last rendition
  // until the chosen one's connections are ready, rather than falling back to a placeholder.
  const [selected, setSelected] = useState<Rendition | undefined>(offered[0]);
  const [shown, setShown] = useState<Rendition | undefined>(offered[0]);
  if (selected === undefined || shown === undefined) return null;
  return (
    <>
      <RenditionTabs
        renditions={offered}
        value={selected}
        onValueChange={chosen => {
          setSelected(chosen);
          startTransition(() => setShown(chosen));
        }}
      />
      <ReadList read={read} rendition={shown} name={name} />
    </>
  );
};

/** How a reader uses each protocol's URL, in a sentence: what to paste it into. */
const protocolHowTo = {
  webrtc: 'In OBS, add a WHEP source and paste the endpoint and bearer token; a browser player takes the same two.',
  rtsp: 'Paste into VLC (Open Network Stream), ffmpeg or a recorder.',
  rtsps: 'Paste into a player that speaks RTSPS, such as ffmpeg or VLC.',
  rtmp: 'Paste as a Media Source’s input in OBS (untick Local File), or into ffmpeg.',
  rtmps: 'Paste into a player or encoder that speaks RTMPS, such as ffmpeg.',
  hls: 'Paste into Safari, VLC or any HLS player; it plays a few seconds behind.'
} satisfies Record<(typeof GATEWAY_PROTOCOLS)[number]['protocol'], string>;

/** What each protocol is for, in a line. */
const protocolUses = {
  webrtc: 'Lowest delay, in a browser or OBS, by WHEP',
  rtsp: 'VLC, ffmpeg and recorders',
  rtsps: 'RTSP over TLS',
  rtmp: 'OBS and encoders',
  rtmps: 'RTMP over TLS',
  hls: 'Any browser or player, a few seconds behind'
} satisfies Record<(typeof GATEWAY_PROTOCOLS)[number]['protocol'], string>;

interface ReadListProps {
  read: ProtocolReadOf;
  rendition: Rendition;
  name: GatewayName | null;
}

/**
 * One row per protocol the gateway serves readers. A row's name and use are known already, so they show at once; only
 * its buttons wait on its connection, behind a placeholder the buttons' height, so nothing moves when they arrive.
 */
const ReadList: FC<ReadListProps> = ({ read, rendition, name }) => {
  return (
    <ReadRows>
      {GATEWAY_PROTOCOLS.map(({ protocol, label }) => (
        <ReadRow key={protocol}>
          <ReadRowHeading>
            <ReadRowTitle>{label}</ReadRowTitle>
            <ReadRowNote>{protocolUses[protocol]}</ReadRowNote>
          </ReadRowHeading>
          <Suspense fallback={<Skeleton className="h-7 w-56" />}>
            <ProtocolReadActions query={read(protocol, rendition)} protocol={protocol} label={label} name={name} />
          </Suspense>
        </ReadRow>
      ))}
    </ReadRows>
  );
};

interface ProtocolReadActionsProps {
  /** The protocol's connection for the rendition. */
  query: ProtocolReadQueryOptions;
  protocol: ReadProtocol;
  label: string;
  name: GatewayName | null;
}

/** One protocol's connection for the rendition, as its buttons. */
const ProtocolReadActions: FC<ProtocolReadActionsProps> = ({ query, protocol, label, name }) => {
  const readQuery = useSuspenseQuery(query);
  return <ProtocolActions protocol={protocol} label={label} read={readQuery.data} name={name} />;
};

/** A protocol the gateway gave a connection for. */
type ReadConnection = ProtocolReadable;

/** One way to reach the gateway: by its hostname, or at an IP. */
interface Variant {
  /** What the button says. */
  label: string;
  /** The URL there, without a token. */
  url: string;
  /** Whether the server's certificate won't match: an encrypted protocol reached at an IP rather than the hostname. */
  mismatched: boolean;
  /** Why a reader would use this way to reach it, in a sentence. */
  reason: string;
}

/** A protocol a MediaMTX gateway serves readers. */
type ReadProtocol = (typeof GATEWAY_PROTOCOLS)[number]['protocol'];

interface ProtocolActionsProps {
  protocol: ReadProtocol;
  label: string;
  read: ProtocolRead | undefined;
  name: GatewayName | null;
}

/** The protocol's variants as buttons, and for WebRTC the feed in the browser; or why it can't be read. */
const ProtocolActions: FC<ProtocolActionsProps> = ({ protocol, label, read, name }) => {
  if (!read || !('url' in read)) {
    return <span className="max-w-sm text-custom-12 text-custom-text-secondary">{read?.failure}</span>;
  }
  const variants = variantsOf(read.url, name);
  return (
    <ReadRowActions>
      {protocol === 'webrtc' ? (
        <>
          {variants.map(variant => (
            <WhepDialog key={variant.label} label={label} variant={variant} read={read} />
          ))}
          {read.token && variants[0] && <OpenPlayer whepUrl={variants[0].url} token={read.token} />}
        </>
      ) : (
        variants.map(variant => <CopyUrlButton key={variant.label} protocol={protocol} variant={variant} read={read} />)
      )}
    </ReadRowActions>
  );
};

/** The schemes whose servers present the gateway's certificate, which names only its hostname. */
const ENCRYPTED_SCHEMES = new Set(['https:', 'rtsps:', 'rtmps:']);

/**
 * The ways to reach the URL: at the hostname and at the IP it points at when the URL is under the hostname, otherwise
 * just where it is.
 */
function variantsOf(url: string, name: GatewayName | null): Variant[] {
  const parsed = new URL(url);
  if (!name || name.address === null || parsed.hostname !== name.hostname) {
    return [
      { label: parsed.hostname, url, mismatched: false, reason: 'Where the agent running the gateway serves it.' }
    ];
  }
  const atAddress = new URL(url);
  atAddress.hostname = name.address.includes(':') ? `[${name.address}]` : name.address;
  return [
    {
      label: 'Hostname',
      url,
      mismatched: false,
      reason: 'By the gateway’s name, which finds the agent even if its address changes, and matches its certificate.'
    },
    {
      label: name.address,
      url: atAddress.href,
      mismatched: ENCRYPTED_SCHEMES.has(parsed.protocol),
      reason: `At ${name.address}, the agent’s own address on the network: for a device whose DNS can’t look the name up.`
    }
  ];
}

/** The URL carrying the token as MediaMTX reads it from a query, for every protocol. */
function withToken(url: string, token: string | undefined): string {
  const authenticated = new URL(url);
  if (token !== undefined) authenticated.searchParams.set('jwt', token);
  return authenticated.href;
}

interface VariantButtonContentProps {
  variant: Variant;
  /** The icon at the end: what pressing it does. */
  action: ReactNode;
}

/** A variant's face: a globe for the hostname, its address otherwise, and a warning if its certificate won't match. */
const VariantButtonContent: FC<VariantButtonContentProps> = ({ variant, action }) => {
  return (
    <>
      {variant.label === 'Hostname' ? <GlobeSimpleIcon /> : null}
      <span className={variant.label === 'Hostname' ? undefined : 'font-mono'}>{variant.label}</span>
      {variant.mismatched && <WarningIcon className="text-custom-warning" />}
      {action}
    </>
  );
};

interface VariantTipProps {
  variant: Variant;
  /** How to use what the button gives, in a sentence. */
  howTo: string;
  /** What pressing it does, in a few words, ending in a full stop. */
  children: ReactNode;
}

/** What pressing a variant does and how to use it, why this way of reaching the gateway, and how long it lasts. */
const VariantTip: FC<VariantTipProps> = ({ variant, howTo, children }) => {
  return (
    <TooltipContent className="max-w-xs flex-col items-start gap-1.5 py-2 text-left">
      <span className="font-medium">{children}</span>
      <span>{howTo}</span>
      <span className="opacity-80">{variant.reason}</span>
      {variant.mismatched && (
        <span className="opacity-80">
          Its certificate names the hostname, so the player has to be told to accept it.
        </span>
      )}
      <span className="opacity-80">It carries a read token for you that lasts an hour; copy it again after that.</span>
    </TooltipContent>
  );
};

interface CopyUrlButtonProps {
  protocol: ReadProtocol;
  variant: Variant;
  read: ReadConnection;
}

/** Copies the variant's whole working URL, its token included. */
const CopyUrlButton: FC<CopyUrlButtonProps> = ({ protocol, variant, read }) => {
  const { copied, copy } = useCopy();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`Copy the ${variant.label === 'Hostname' ? 'hostname' : variant.label} URL with its token`}
            onClick={() => copy(withToken(variant.url, read.token))}
          />
        }
      >
        <VariantButtonContent variant={variant} action={copied ? <CheckIcon /> : <CopyIcon />} />
      </TooltipTrigger>
      <VariantTip variant={variant} howTo={protocolHowTo[protocol]}>
        {copied ? 'Copied.' : 'Copies a URL that plays as it is.'}
      </VariantTip>
    </Tooltip>
  );
};

interface WhepDialogProps {
  /** The protocol's name, for the dialog's title. */
  label: string;
  variant: Variant;
  read: ReadConnection;
}

/** WebRTC by WHEP at one variant: the endpoint and the bearer header a player sends, each to copy. */
const WhepDialog: FC<WhepDialogProps> = ({ label, variant, read }) => {
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger render={<DialogTrigger render={<Button variant="outline" size="sm" />} />}>
          <VariantButtonContent variant={variant} action={<KeyIcon />} />
        </TooltipTrigger>
        <VariantTip variant={variant} howTo={protocolHowTo.webrtc}>
          Shows the endpoint and token to copy.
        </VariantTip>
      </Tooltip>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {label} at {variant.label === 'Hostname' ? 'its hostname' : variant.label}
          </DialogTitle>
          <DialogDescription>
            A WHEP player (OBS’s WHEP source, a browser player) offers to this endpoint with the bearer token.
            {read.expiresAt && ` The token lasts until ${formatDateTime(read.expiresAt)}.`}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="py-2">
          <CopyField label="Endpoint" value={variant.url} />
          <CopyField label="Bearer token" value={read.token ?? ''} secret>
            Sent as <span className="font-mono">Authorization: Bearer …</span>; OBS asks for it on its own.
          </CopyField>
          {variant.mismatched && (
            <FieldDescription className="text-custom-warning">
              The gateway’s certificate names its hostname, so the player must accept it at this address.
            </FieldDescription>
          )}
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
};

interface CopyFieldProps {
  label: string;
  value: string;
  /** Shown masked, as it is a credential; copied in full. */
  secret?: boolean;
  /** A line under it, if it needs one. */
  children?: ReactNode;
}

/** A read-only value with a button that copies it. */
const CopyField: FC<CopyFieldProps> = ({ label, value, secret = false, children }) => {
  const { copied, copy } = useCopy();
  const id = `copy-${label.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          readOnly
          value={value}
          type={secret ? 'password' : 'text'}
          className="font-mono text-custom-12"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label={`Copy the ${label.toLowerCase()}`} onClick={() => copy(value)}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copied' : 'Copy'}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {children && <FieldDescription>{children}</FieldDescription>}
    </Field>
  );
};

interface OpenPlayerProps {
  /** The WHEP endpoint at the hostname: the player page is beside it. */
  whepUrl: string;
  token: string;
}

/**
 * The feed in MediaMTX's own WebRTC player, in a new tab: the path's page, which hands the token in its URL on to its
 * WHEP request.
 */
const OpenPlayer: FC<OpenPlayerProps> = ({ whepUrl, token }) => {
  const page = withToken(whepUrl.replace(/whep$/u, ''), token);
  return (
    // A link, not a button that navigates: it opens a new tab, and is announced and handled as one.
    <a href={page} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
      <ArrowSquareOutIcon />
      Open in browser
    </a>
  );
};
