import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import type { ExposureParams, Rendition, Settings } from '../topology/settings.ts';

// A gateway provider is everything this API knows about one kind of gateway: what it is called, how a publisher
// delivers an exposure to it (its ingest protocols) and how readers read it (its egress protocols), what an
// organisation registers it with (its settings), and how a caller connects to an exposure there: where, and with what
// short-lived credential. Built-in gateways are providers too, configured by the deployment instead of by settings.
// Define one in its own file with `provider.organisation` or `provider.builtin`, and list it in src/gateways/index.ts.

export const ConnectionActionSchema = z
  .enum(['read', 'publish'])
  .describe('Whether to read the exposure from its gateway, or publish it there.');
export type ConnectionAction = z.output<typeof ConnectionActionSchema>;

/**
 * How a protocol carries an exposure's renditions. `paths`: each connection carries one, so a caller chooses which
 * (RTSP, WebRTC). `tracks`: one connection carries every rendition, and readers choose within it (a MoQ broadcast).
 */
export type Carriage = 'paths' | 'tracks';
type Carriages<Protocol extends string> = Readonly<Record<Protocol, Carriage>>;

/** Connecting to a MoQ relay: dial `relay` at `path`, presenting `token`. */
export interface MoqConnection {
  protocol: 'moq';
  relay: string;
  /** Where on the relay the exposure's broadcasts are, which the token is scoped to: dial `relay` at it. */
  path: string;
  /** The exposure's broadcast under `path`, whose catalogue lists every rendition as a track. */
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
export type Connection = MoqConnection | UrlConnection;

/** What a connection carries: the one rendition chosen, or every rendition of the exposure. */
export interface CarriedRenditions {
  renditions: Rendition[];
}
export type ConnectionDetails = Connection & CarriedRenditions;

/** The exposure being connected to. */
export interface ConnectionExposure {
  id: string;
  renditions: Rendition[];
  params: ExposureParams;
}

/** What every connection is to, whichever gateway it is: one exposure, for one caller. */
export interface ConnectionTarget {
  organisationId: string;
  gatewayId: string;
  exposure: ConnectionExposure;
  /** Who the credentials are for, recorded by gateways that audit them: `user:<id>` or `device:<id>`. */
  subject: string;
}

/** What a caller asks for: an action, by a protocol, at a rendition; unchecked against the gateway and exposure. */
export interface ConnectionAsk {
  action: ConnectionAction;
  protocol: string;
  rendition?: Rendition;
}

/** What every provider is asked, once the protocol and rendition are checked. */
interface ConnectionBase extends ConnectionTarget {
  /** The rendition the connection carries when its protocol carries one per connection; absent when it carries all. */
  rendition?: Rendition;
}

/** Publishing, by one of the gateway's ingest protocols. */
export interface PublishRequest<Protocol extends string> extends ConnectionBase {
  action: 'publish';
  protocol: Protocol;
}

/** Reading, by one of the gateway's egress protocols. */
export interface ReadRequest<Protocol extends string> extends ConnectionBase {
  action: 'read';
  protocol: Protocol;
}

export type ConnectionRequest<Ingest extends string = string, Egress extends string = string> =
  | PublishRequest<Ingest>
  | ReadRequest<Egress>;

/** An organisation's gateway is also asked with the settings it was registered with, already validated. */
export type OrganisationConnectionRequest<
  Ingest extends string,
  Egress extends string,
  GatewaySettings
> = ConnectionRequest<Ingest, Egress> & RegisteredSettings<GatewaySettings>;

interface RegisteredSettings<GatewaySettings> {
  settings: GatewaySettings;
}

/** How long a connection's credentials admit it. Callers ask again before they expire. */
export const CONNECTION_LIFETIME_SECONDS = 3_600;

/** The protocols a provider speaks, each side with how it carries renditions. */
export interface ProviderProtocols<Ingest extends string, Egress extends string> {
  /** How a publisher delivers an exposure to the gateway. */
  ingest: Carriages<Ingest>;
  /** How readers read it. */
  egress: Carriages<Egress>;
}

export interface OrganisationProviderDefinition<
  Ingest extends string,
  Egress extends string,
  SettingsSchema extends z.ZodType
> extends ProviderProtocols<Ingest, Egress> {
  name: string;
  /** What an organisation registers a gateway of this kind with, checked whenever its settings change. */
  settings: SettingsSchema;
  connect: (
    request: OrganisationConnectionRequest<Ingest, Egress, z.output<SettingsSchema>>
  ) => Promise<ConnectionFor<Ingest | Egress>>;
}

export interface BuiltinProviderDefinition<
  Kind extends string,
  Ingest extends string,
  Egress extends string
> extends ProviderProtocols<Ingest, Egress> {
  name: string;
  /** The implementation, as the gateway routes list it beside organisations' gateways. */
  kind: Kind;
  connect: (request: ConnectionRequest<Ingest, Egress>) => Promise<ConnectionFor<Ingest | Egress>>;
}

/** A connection as a caller asks for it, to its target. */
export interface RequestedConnection extends ConnectionTarget, ConnectionAsk {}

/** A provider as the registry uses it: whichever gateway, it checks what the caller asked for itself. */
export interface GatewayProvider extends ProviderProtocols<string, string> {
  name: string;
  connect: (request: RequestedConnection, settings: Settings) => Promise<ConnectionDetails>;
}

export interface OrganisationProvider extends GatewayProvider {
  /** Refuses settings a gateway of this kind cannot be registered with, as `invalid_settings`. */
  checkSettings: (settings: Settings) => void;
}

export interface BuiltinProvider<Kind extends string = string> extends GatewayProvider {
  kind: Kind;
}

/**
 * The rendition a connection carries: none chosen for `tracks`, which carry them all, and for `paths` the one asked
 * for, or the exposure's only one. Refuses a rendition the exposure does not offer, and asking for none of several.
 */
function carriedRendition(carriage: Carriage, exposure: ConnectionExposure, requested: Rendition | undefined) {
  if (requested !== undefined && !exposure.renditions.includes(requested))
    throw new ApiFailure('rendition_not_offered');
  if (carriage === 'tracks') return undefined;
  if (requested !== undefined) return requested;
  if (exposure.renditions.length === 1) return exposure.renditions[0];
  throw new ApiFailure('rendition_required');
}

/** The request narrowed to the provider's protocols, refusing a protocol it does not speak for the action. */
function narrowed<Ingest extends string, Egress extends string>(
  protocols: ProviderProtocols<Ingest, Egress>,
  request: RequestedConnection
) {
  const carriages: Readonly<Record<string, Carriage>> = request.action === 'read' ? protocols.egress : protocols.ingest;
  if (!Object.hasOwn(carriages, request.protocol)) throw new ApiFailure('unsupported_protocol');
  const rendition = carriedRendition(carriages[request.protocol]!, request.exposure, request.rendition);
  // SAFETY: `protocol` is a key of the carriages for the action: an ingest protocol to publish, an egress one to read.
  const resolved = { ...request, rendition } as ConnectionRequest<Ingest, Egress>;
  const renditions = rendition === undefined ? request.exposure.renditions : [rendition];
  return { resolved, renditions };
}

export const provider = {
  /** A kind of gateway organisations register, with settings of their own. */
  organisation<const Ingest extends string, const Egress extends string, SettingsSchema extends z.ZodType>(
    definition: OrganisationProviderDefinition<Ingest, Egress, SettingsSchema>
  ): OrganisationProvider {
    return {
      name: definition.name,
      ingest: definition.ingest,
      egress: definition.egress,
      checkSettings: settings => {
        const parsed = definition.settings.safeParse(settings);
        if (!parsed.success) throw new ApiFailure('invalid_settings', { cause: parsed.error });
      },
      connect: async (request, settings) => {
        // Settings were checked when they were written; a gateway that fails now predates a change to its kind.
        const parsed = definition.settings.safeParse(settings);
        if (!parsed.success) throw new ApiFailure('gateway_unavailable', { cause: parsed.error });
        const { resolved, renditions } = narrowed(definition, request);
        const connection = await definition.connect({ ...resolved, settings: parsed.data });
        return { ...connection, renditions };
      }
    };
  },
  /** A gateway every organisation can deliver to, configured by the deployment. */
  builtin<const Kind extends string, const Ingest extends string, const Egress extends string>(
    definition: BuiltinProviderDefinition<Kind, Ingest, Egress>
  ): BuiltinProvider<Kind> {
    return {
      name: definition.name,
      kind: definition.kind,
      ingest: definition.ingest,
      egress: definition.egress,
      connect: async request => {
        const { resolved, renditions } = narrowed(definition, request);
        const connection = await definition.connect(resolved);
        return { ...connection, renditions };
      }
    };
  }
};
