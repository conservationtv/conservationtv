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

/** What a connection carries: the one rendition chosen, or every rendition of the exposure. */
interface CarriedRenditions {
  renditions: Rendition[];
}

/** The connection details a caller is given, with what the connection carries. */
export type ConnectionDetails = (MoqConnection | UrlConnection) & CarriedRenditions;

/** The exposure being connected to. */
export interface ConnectionExposure {
  id: string;
  renditions: Rendition[];
  params: ExposureParams;
}

/**
 * A connection as a caller asks for it: to one exposure, for one caller, by an action, a protocol and a rendition,
 * unchecked against the gateway and the exposure.
 */
export interface RequestedConnection {
  organisationId: string;
  gatewayId: string;
  exposure: ConnectionExposure;
  /** Who the credentials are for, recorded by gateways that audit them: `user:<id>` or `device:<id>`. */
  subject: string;
  action: ConnectionAction;
  protocol: string;
  rendition?: Rendition;
}

/**
 * What a provider is asked, once the protocol is one it speaks for the action (an ingest protocol to publish, an egress
 * one to read), and `rendition` is the one the connection carries: absent when its protocol carries them all.
 */
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

/** What every provider is defined with: its protocols, each side with how it carries renditions, and how to connect. */
interface ProviderDefinition<Ingest extends string, Egress extends string, GatewaySettings> {
  name: string;
  /** How a publisher delivers an exposure to the gateway. */
  ingest: Carriages<Ingest>;
  /** How readers read it. */
  egress: Carriages<Egress>;
  connect: (request: ProviderRequest<Ingest, Egress, GatewaySettings>) => Promise<ConnectionFor<Ingest | Egress>>;
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
  ingest: Carriages<string>;
  egress: Carriages<string>;
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

/**
 * The registry's `connect` for a definition: the settings parsed, the request narrowed to the provider's protocols
 * (refusing one it does not speak for the action) and its rendition settled, and what the connection carries added.
 */
function connector<Ingest extends string, Egress extends string, GatewaySettings>(
  definition: ProviderDefinition<Ingest, Egress, GatewaySettings>,
  parseSettings: (settings: Settings) => GatewaySettings
): GatewayProvider['connect'] {
  return async (request, settings) => {
    const parsed = parseSettings(settings);
    const carriages: Carriages<string> = request.action === 'read' ? definition.egress : definition.ingest;
    if (!Object.hasOwn(carriages, request.protocol)) throw new ApiFailure('unsupported_protocol');
    const rendition = carriedRendition(carriages[request.protocol]!, request.exposure, request.rendition);
    // SAFETY: `protocol` is a key of the carriages for the action: an ingest protocol to publish, an egress one to read.
    const narrowed = { ...request, rendition, settings: parsed } as ProviderRequest<Ingest, Egress, GatewaySettings>;
    const connection = await definition.connect(narrowed);
    return { ...connection, renditions: rendition === undefined ? request.exposure.renditions : [rendition] };
  };
}

export const provider = {
  /** A kind of gateway organisations register, with settings of their own. */
  organisation<const Ingest extends string, const Egress extends string, SettingsSchema extends z.ZodType>(
    definition: OrganisationProviderDefinition<Ingest, Egress, SettingsSchema>
  ): OrganisationProvider {
    const { name, ingest, egress, settings: schema } = definition;
    return {
      name,
      ingest,
      egress,
      checkSettings: settings => {
        const parsed = schema.safeParse(settings);
        if (!parsed.success) throw new ApiFailure('invalid_settings', { cause: parsed.error });
      },
      connect: connector(definition, settings => {
        // Settings were checked when they were written; a gateway that fails now predates a change to its kind.
        const parsed = schema.safeParse(settings);
        if (!parsed.success) throw new ApiFailure('gateway_unavailable', { cause: parsed.error });
        return parsed.data;
      })
    };
  },
  /** A gateway every organisation can deliver to, configured by the deployment. */
  builtin<const Kind extends string, const Ingest extends string, const Egress extends string>(
    definition: BuiltinProviderDefinition<Kind, Ingest, Egress>
  ): BuiltinProvider<Kind> {
    const { name, kind, ingest, egress } = definition;
    return { name, kind, ingest, egress, connect: connector(definition, settings => settings) };
  }
};
