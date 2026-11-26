import { Suspense, useState, type FC } from 'react';
import { Button } from '@conservationtv/ui/components/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@conservationtv/ui/components/item';

import { CopyButton } from '@/components/common/copy-button';
import { FormError } from '@/components/common/form-error';
import { Section, SectionDescription, SectionHeader, SectionHeading, SectionTitle } from '@/components/common/page';
import { PlaceField } from '@/components/go-live/place-field';
import { useOrganisationId } from '@/hooks/use-organisation';
import { useEnsureEncoder, useReplaceStreamKey } from '@/queries/publishing';

// Publishing a stream with no source of its own from an encoder that only takes a URL, such as OBS or a phone's
// streaming app (docs/shows.md, Going live): where to send it, and the stream's key, which lasts until it is
// replaced. Shown only on asking, to those who may hold the key; the API refuses anyone else.

export interface EncoderSettingsProps {
  streamId: string;
}

/** What a protocol is called to its person, and what an encoder calls it. */
function protocolName(protocol: string): string {
  switch (protocol) {
    case 'rtmps':
      return 'RTMPS (OBS: “Custom…” service)';
    case 'rtmp':
      return 'RTMP, on site (OBS: “Custom…” service)';
    case 'webrtc':
      return 'WHIP (OBS: “WHIP” service)';
    default:
      return protocol;
  }
}

/** Where an encoder publishes by one protocol, as the API gives it. */
interface Server {
  protocol: string;
  url: string;
  server?: string;
  streamKey?: string;
  bearerToken?: string;
}

/** The stream's encoder settings, asked for on a press: where it is, then what to paste, and replacing the key. */
export const EncoderSettings: FC<EncoderSettingsProps> = ({ streamId }) => {
  const organisationId = useOrganisationId();
  const ensure = useEnsureEncoder(organisationId, streamId);
  const replace = useReplaceStreamKey(organisationId, streamId);
  const [networkId, setNetworkId] = useState<string | null>(null);
  const settings = ensure.data;
  return (
    <Section>
      <SectionHeader>
        <SectionHeading>
          <SectionTitle>Encoder</SectionTitle>
          <SectionDescription>
            Publish it from OBS or a phone’s streaming app: paste the server and stream key into it. The key lasts until
            it is replaced, so keep it secret.
          </SectionDescription>
        </SectionHeading>
      </SectionHeader>
      <Suspense fallback={null}>
        <PlaceField
          id={`${streamId}-encoder-place`}
          value={networkId ?? ''}
          onChange={event => {
            setNetworkId(event.target.value === '' ? null : event.target.value);
            ensure.reset();
          }}
        >
          Where is the encoder?
        </PlaceField>
      </Suspense>
      {settings === undefined ? (
        <Button className="self-start" loading={ensure.isPending} onClick={() => ensure.mutate(networkId)}>
          Show encoder settings
        </Button>
      ) : (
        <>
          <ItemGroup className="gap-2">
            {settings.servers.map(server => (
              <EncoderServer key={server.protocol} server={server} />
            ))}
          </ItemGroup>
          <Button
            variant="outline"
            className="self-start"
            loading={replace.isPending || ensure.isPending}
            onClick={async () => {
              await replace.mutateAsync();
              ensure.mutate(networkId);
            }}
          >
            Replace key
          </Button>
          <p className="text-custom-12 text-muted-foreground">
            Replacing the key refuses an encoder with the old one from its next connection, within about half a minute.
          </p>
        </>
      )}
      <FormError error={ensure.error ?? replace.error} />
    </Section>
  );
};

interface EncoderServerProps {
  server: Server;
}

/**
 * What to paste for one protocol: a server and a stream key apart, for an encoder that asks for them so (OBS's RTMP);
 * otherwise the whole URL, with the bearer token beside it for WHIP.
 */
const EncoderServer: FC<EncoderServerProps> = ({ server }) => {
  const apart = server.server !== undefined && server.streamKey !== undefined;
  return (
    <Item variant="outline" className="items-start">
      <ItemContent className="min-w-0 gap-2">
        <ItemTitle>{protocolName(server.protocol)}</ItemTitle>
        <EncoderValue label="Server" value={apart ? (server.server ?? '') : server.url} />
        {apart && <EncoderValue label="Stream key" value={server.streamKey ?? ''} secret />}
        {server.bearerToken !== undefined && <EncoderValue label="Bearer token" value={server.bearerToken} secret />}
      </ItemContent>
    </Item>
  );
};

interface EncoderValueProps {
  label: string;
  value: string;
  /** Hidden until shown, as a stream key is. */
  secret?: boolean;
}

/** One value to paste into an encoder, with a button that copies it; a secret one hidden until shown. */
const EncoderValue: FC<EncoderValueProps> = ({ label, value, secret = false }) => {
  const [shown, setShown] = useState(!secret);
  return (
    <ItemDescription className="flex min-w-0 items-center gap-2 text-custom-12">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-foreground">{shown ? value : '••••••••••••'}</code>
      {secret && (
        <Button variant="ghost" size="xs" onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'}
        </Button>
      )}
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
    </ItemDescription>
  );
};
