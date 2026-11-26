import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import type { Settings } from '../topology/settings.ts';

// A gateway provider is everything this API knows about one kind of gateway: what it is called, how a publisher
// delivers to it (its ingest protocols) and how readers read it (its egress protocols), what an organisation registers
// it with (its settings), how a caller connects to a delivery there, a stream's exposure or a show's preview: where,
// and with what short-lived credential; and, for a kind that can say, which deliveries there are live now, from the
// gateway's own source of truth; and, for a kind an encoder that only takes a URL can publish to, what that encoder is
// given to paste (`encoder`). Built-in gateways are providers too, configured by the deployment instead of by settings.
// Define one in its own file with `provider.organisation` or `provider.builtin`, and list it in src/gateways/index.ts.

export const ConnectionActionSchema = z
  .enum(['read', 'publish'])
  .describe('Whether to read the exposure from its gateway, or publish it there.');
export type ConnectionAction = z.output<typeof ConnectionActionSchema>;

/** The protocols one side of a gateway speaks. */
type Protocols<Protocol extends string> = readonly Protocol[];

/** Connecting to a MoQ relay: dial `relay` at `path`, presenting `token`. */
export interface MoqConnection {
  protocol: 'moq';
  relay: string;
  /** Where on the relay the delivery's broadcasts are, which the token is scoped to: dial `relay` at it. */
  path: string;
  /**
   * The delivery's broadcast under `path`, whose catalog lists its picture, and where the publisher can give them,
   * smaller ones beside it: a reader picks by the size it needs.
   */
  broadcast: string;
  /** Absent when the relay admits every connection. */
  token?: string;
  /** When the token stops admitting connections; ask again before then. */
  expiresAt?: string;
}

/**
 * Connecting by URL, such as a WHEP or WHIP endpoint for WebRTC, or an RTSP URL. Present `token` as a bearer token,
 * or where the protocol has no headers (RTSP, RTMP) as its `jwt` query parameter: as a password it is too long for
 * some clients, FFmpeg's among them.
 */
export interface UrlConnection<Protocol extends string = string> {
  protocol: Protocol;
  url: string;
  token?: string;
  expiresAt?: string;
}

/** The connection details for each of a provider's protocols: discriminated by `protocol`. */
export type ConnectionFor<Protocol extends string> = Protocol extends 'moq' ? MoqConnection : UrlConnection<Protocol>;

/** The connection details a caller is given. */
export type ConnectionDetails = MoqConnection | UrlConnection;

/** What is being connected to at the gateway: a stream's exposure or a show's preview, by its ID, which names where it is there. */
export interface ConnectionDelivery {
  id: string;
}

/**
 * A connection as a caller asks for it: to one delivery, for one caller, by an action and a protocol, unchecked
 * against the gateway and the delivery.
 */
export interface RequestedConnection {
  organisationId: string;
  gatewayId: string;
  delivery: ConnectionDelivery;
  /** Who the credentials are for, recorded by gateways that audit them: `user:<id>` or `device:<id>`. */
  subject: string;
  action: ConnectionAction;
  protocol: string;
}

/** What a provider is asked, once the protocol is one it speaks for the action: an ingest protocol to publish, an egress one to read. */
export type ConnectionRequest<Ingest extends string = string, Egress extends string = string> = Omit<
  RequestedConnection,
  'action' | 'protocol'
> &
  (Publishing<Ingest> | Reading<Egress>);

interface Publishing<Protocol extends string> {
  action: 'publish';
  protocol: Protocol;
}

interface Reading<Protocol extends string> {
  action: 'read';
  protocol: Protocol;
}

/** A provider is asked with the settings its gateway was registered with, already validated: none for a built-in one. */
interface RegisteredSettings<GatewaySettings> {
  settings: GatewaySettings;
}
type ProviderRequest<Ingest extends string, Egress extends string, GatewaySettings> = ConnectionRequest<
  Ingest,
  Egress
> &
  RegisteredSettings<GatewaySettings>;

/** How long a connection's credentials admit it. Callers ask again before they expire. */
export const CONNECTION_LIFETIME_SECONDS = 3_600;

/** What every provider is defined with: its protocols on each side, and how to connect. */
interface ProviderDefinition<Ingest extends string, Egress extends string, GatewaySettings> {
  name: string;
  /** How a publisher delivers to the gateway. */
  ingest: Protocols<Ingest>;
  /** How readers read it. */
  egress: Protocols<Egress>;
  connect: (request: ProviderRequest<Ingest, Egress, GatewaySettings>) => Promise<ConnectionFor<Ingest | Egress>>;
  /** Where to read the gateway's traffic stats about an organisation, for a gateway that publishes them. */
  stats?: (request: StatsRequest) => Promise<StatsConnection>;
  /** Which of an organisation's deliveries at the gateway are live now, for a gateway that can say. */
  live?: (request: LiveRequest) => Promise<LiveDeliveries>;
  /** Where an encoder publishes a delivery by its stream's key, for a gateway that admits one so. */
  encoder?: (request: EncoderRequest & RegisteredSettings<GatewaySettings>) => Promise<EncoderServer[]>;
  /**
   * Which of its protocols the gateway has a server for now, for a gateway whose servers are registered by whatever runs
   * it (src/services/gateway-endpoints.ts): given the protocols registered for it, the ones a connection by would not
   * be refused as `gateway_unavailable`. Absent for a gateway that serves all of them always.
   */
  served?: (registered: ReadonlySet<string>, settings: GatewaySettings) => ReadonlySet<string>;
}

/** What an encoder is to be given for publishing one delivery with its stream's key. */
export interface EncoderRequest {
  organisationId: string;
  gatewayId: string;
  delivery: ConnectionDelivery;
  /** The stream's key, which the encoder presents. */
  key: string;
}

/**
 * Where an encoder that only takes a URL (OBS, a phone's streaming app) publishes a delivery by one protocol, with the
 * stream's key in it: `url` whole, for an encoder that takes one URL; for one that asks for a server and a stream key
 * apart (OBS's RTMP), `server` and `streamKey`, which joined by a `/` are `url`; for WHIP, the endpoint as `url` and
 * the key as the `bearerToken` to present.
 */
export interface EncoderServer {
  protocol: string;
  url: string;
  server?: string;
  streamKey?: string;
  bearerToken?: string;
}

/** Which of an organisation's deliveries at one gateway are live, asked for a caller. */
export interface LiveRequest {
  organisationId: string;
  gatewayId: string;
  /** The deliveries asked of, by ID: the organisation's exposures at the gateway. */
  deliveryIds: string[];
  /** Who any credentials are for, recorded by gateways that audit them: `user:<id>` or `device:<id>`. */
  subject: string;
}

/** Whether each delivery asked of is live now, by its ID: null for one the gateway cannot say of. */
export type LiveDeliveries = Record<string, boolean | null>;

/** Stats asked for: an organisation's, for a caller. */
export interface StatsRequest {
  organisationId: string;
  /** Who the credentials are for, recorded by gateways that audit them: `user:<id>` or `device:<id>`. */
  subject: string;
}

/**
 * Where to read a MoQ relay's traffic stats about an organisation: dial `relay` at `path`, presenting `token`, and every
 * relay node's stats broadcast is announced beneath it, `node/<node>`, with `publisher.json` (what the node sent) and
 * `subscriber.json` (what it received), each a JSON object of cumulative counters by broadcast path.
 */
export interface StatsConnection {
  protocol: 'moq';
  relay: string;
  path: string;
  token?: string;
  expiresAt?: string;
}

interface OrganisationProviderDefinition<
  Ingest extends string,
  Egress extends string,
  SettingsSchema extends z.ZodType
> extends ProviderDefinition<Ingest, Egress, z.output<SettingsSchema>> {
  /** What an organisation registers a gateway of this kind with, checked whenever its settings change. */
  settings: SettingsSchema;
}

interface BuiltinProviderDefinition<
  Kind extends string,
  Ingest extends string,
  Egress extends string
> extends ProviderDefinition<Ingest, Egress, Settings> {
  /** The implementation, as the gateway routes list it beside organisations' gateways. */
  kind: Kind;
}

/** A provider as the registry uses it: whichever gateway, it checks what the caller asked for itself. */
export interface GatewayProvider {
  name: string;
  ingest: Protocols<string>;
  egress: Protocols<string>;
  connect: (request: RequestedConnection, settings: Settings) => Promise<ConnectionDetails>;
  /** Absent for a gateway that publishes no traffic stats. */
  stats?: (request: StatsRequest) => Promise<StatsConnection>;
  /** Absent for a gateway that cannot say what is live on it. */
  live?: (request: LiveRequest) => Promise<LiveDeliveries>;
  /** Absent for a gateway no encoder publishes to with a stream key. */
  encoder?: (request: EncoderRequest, settings: Settings) => Promise<EncoderServer[]>;
  /** Absent for a gateway that serves all its protocols always. */
  served?: (registered: ReadonlySet<string>, settings: Settings) => ReadonlySet<string>;
}

/**
 * The protocols the gateway is read by (`egress`) or published to (`ingest`) that it has a server for now: those its
 * provider says are served, given what is registered for it, or all of them for a gateway that serves them always. A
 * gateway whose settings no longer parse serves none.
 */
export function servedProtocols(
  gatewayProvider: GatewayProvider,
  side: 'ingest' | 'egress',
  registered: ReadonlySet<string>,
  settings: Settings
): string[] {
  const protocols = gatewayProvider[side];
  if (gatewayProvider.served === undefined) return [...protocols];
  try {
    const served = gatewayProvider.served(registered, settings);
    return protocols.filter(protocol => served.has(protocol));
  } catch {
    return [];
  }
}

export interface OrganisationProvider extends GatewayProvider {
  /** Refuses settings a gateway of this kind cannot be registered with, as `invalid_settings`. */
  checkSettings: (settings: Settings) => void;
}

export interface BuiltinProvider<Kind extends string = string> extends GatewayProvider {
  kind: Kind;
}

/**
 * The registry's `connect` for a definition: the settings parsed, and the request narrowed to the provider's protocols,
 * refusing one it does not speak for the action.
 */
function connector<Ingest extends string, Egress extends string, GatewaySettings>(
  definition: ProviderDefinition<Ingest, Egress, GatewaySettings>,
  parseSettings: (settings: Settings) => GatewaySettings
): GatewayProvider['connect'] {
  return async (request, settings) => {
    const parsed = parseSettings(settings);
    const protocols: Protocols<string> = request.action === 'read' ? definition.egress : definition.ingest;
    if (!protocols.includes(request.protocol)) throw new ApiFailure('unsupported_protocol');
    // SAFETY: `protocol` is one the provider speaks for the action: an ingest protocol to publish, an egress one to read.
    const narrowed = { ...request, settings: parsed } as ProviderRequest<Ingest, Egress, GatewaySettings>;
    return definition.connect(narrowed);
  };
}

export const provider = {
  /** A kind of gateway organisations register, with settings of their own. */
  organisation<const Ingest extends string, const Egress extends string, SettingsSchema extends z.ZodType>(
    definition: OrganisationProviderDefinition<Ingest, Egress, SettingsSchema>
  ): OrganisationProvider {
    const { name, ingest, egress, live, encoder, served, settings: schema } = definition;
    const parse = (settings: Settings) => {
      // Settings were checked when they were written; a gateway that fails now predates a change to its kind.
      const parsed = schema.safeParse(settings);
      if (!parsed.success) throw new ApiFailure('gateway_unavailable', { cause: parsed.error });
      return parsed.data;
    };
    return {
      name,
      ingest,
      egress,
      live,
      encoder: encoder && ((request, settings) => encoder({ ...request, settings: parse(settings) })),
      served: served && ((registered, settings) => served(registered, parse(settings))),
      checkSettings: settings => {
        const parsed = schema.safeParse(settings);
        if (!parsed.success) throw new ApiFailure('invalid_settings', { cause: parsed.error });
      },
      connect: connector(definition, parse)
    };
  },
  /** A gateway every organisation can deliver to, configured by the deployment. */
  builtin<const Kind extends string, const Ingest extends string, const Egress extends string>(
    definition: BuiltinProviderDefinition<Kind, Ingest, Egress>
  ): BuiltinProvider<Kind> {
    const { name, kind, ingest, egress, stats, live } = definition;
    return { name, kind, ingest, egress, stats, live, connect: connector(definition, settings => settings) };
  }
};
