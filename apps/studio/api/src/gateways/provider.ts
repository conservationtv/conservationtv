import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import type { ExposureParams, Settings } from '../topology/settings.ts';

// A gateway provider is everything this API knows about one kind of gateway: what it is called, the protocols it
// accepts, what an organisation registers it with (its settings), and how a caller connects to an exposure there:
// where, and with what short-lived credential. Built-in gateways are providers too, configured by the deployment
// instead of by settings. Define one in its own file with `provider.organisation` or `provider.builtin`, and list it
// in src/gateways/index.ts.

export const ConnectionActionSchema = z
  .enum(['read', 'publish'])
  .describe('Whether to read the exposure from its gateway, or publish it there.');
export type ConnectionAction = z.output<typeof ConnectionActionSchema>;

/** Connecting to a MoQ relay: dial `relay` at `path`, presenting `token`. */
export interface MoqConnection {
  protocol: 'moq';
  relay: string;
  /** The broadcast's path on the relay, which the token is scoped to. */
  path: string;
  /** Absent when the relay admits every connection. */
  token?: string;
  /** When the token stops admitting connections; ask again before then. */
  expiresAt?: string;
}

/**
 * Connecting by URL, such as a WHEP or WHIP endpoint for WebRTC, or an RTSP URL. Present `token` as a bearer token,
 * or as the password where the protocol has no headers.
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

/** The exposure being connected to, by one of its gateway's protocols. */
export interface ConnectionExposure<Protocol extends string = string> {
  id: string;
  protocol: Protocol;
  params: ExposureParams;
}

/** What every provider is asked, whichever gateway it is: one exposure, one action, for one caller. */
export interface ConnectionRequest<Protocol extends string = string> {
  organisationId: string;
  gatewayId: string;
  exposure: ConnectionExposure<Protocol>;
  action: ConnectionAction;
  /** Who the credentials are for, recorded by gateways that audit them: `user:<id>` or `device:<id>`. */
  subject: string;
}

/** An organisation's gateway is also asked with the settings it was registered with, already validated. */
export interface OrganisationConnectionRequest<
  Protocol extends string,
  GatewaySettings
> extends ConnectionRequest<Protocol> {
  settings: GatewaySettings;
}

/** How long a connection's credentials admit it. Callers ask again before they expire. */
export const CONNECTION_LIFETIME_SECONDS = 3_600;

type Protocols<Protocol extends string> = readonly [Protocol, ...Protocol[]];

export interface OrganisationProviderDefinition<Protocol extends string, SettingsSchema extends z.ZodType> {
  name: string;
  protocols: Protocols<Protocol>;
  /** What an organisation registers a gateway of this kind with, checked whenever its settings change. */
  settings: SettingsSchema;
  connect: (
    request: OrganisationConnectionRequest<Protocol, z.output<SettingsSchema>>
  ) => Promise<ConnectionFor<Protocol>>;
}

export interface BuiltinProviderDefinition<Kind extends string, Protocol extends string> {
  name: string;
  /** The implementation, as the gateway routes list it beside organisations' gateways. */
  kind: Kind;
  protocols: Protocols<Protocol>;
  connect: (request: ConnectionRequest<Protocol>) => Promise<ConnectionFor<Protocol>>;
}

/** A provider as the registry uses it: whichever gateway, it takes the exposure's protocol and settings unchecked. */
export interface GatewayProvider {
  name: string;
  protocols: readonly string[];
  connect: (request: ConnectionRequest, settings: Settings) => Promise<Connection>;
}

export interface OrganisationProvider extends GatewayProvider {
  /** Refuses settings a gateway of this kind cannot be registered with, as `invalid_settings`. */
  checkSettings: (settings: Settings) => void;
}

export interface BuiltinProvider<Kind extends string = string> extends GatewayProvider {
  kind: Kind;
}

/** Narrows the exposure's protocol to the provider's, refusing one it does not accept. */
function accepted<Protocol extends string>(
  protocols: Protocols<Protocol>,
  request: ConnectionRequest
): ConnectionRequest<Protocol> {
  const { protocol } = request.exposure;
  const listed: readonly string[] = protocols;
  if (!listed.includes(protocol)) throw new ApiFailure('unsupported_protocol');
  // SAFETY: `protocol` is one of `protocols`, which are `Protocol`s.
  return { ...request, exposure: { ...request.exposure, protocol: protocol as Protocol } };
}

export const provider = {
  /** A kind of gateway organisations register, with settings of their own. */
  organisation<const Protocol extends string, SettingsSchema extends z.ZodType>(
    definition: OrganisationProviderDefinition<Protocol, SettingsSchema>
  ): OrganisationProvider {
    return {
      name: definition.name,
      protocols: definition.protocols,
      checkSettings: settings => {
        const parsed = definition.settings.safeParse(settings);
        if (!parsed.success) throw new ApiFailure('invalid_settings', { cause: parsed.error });
      },
      connect: async (request, settings) => {
        // Settings were checked when they were written; a gateway that fails now predates a change to its kind.
        const parsed = definition.settings.safeParse(settings);
        if (!parsed.success) throw new ApiFailure('gateway_unavailable', { cause: parsed.error });
        const narrowed = accepted(definition.protocols, request);
        return definition.connect({ ...narrowed, settings: parsed.data });
      }
    };
  },
  /** A gateway every organisation can deliver to, configured by the deployment. */
  builtin<const Kind extends string, const Protocol extends string>(
    definition: BuiltinProviderDefinition<Kind, Protocol>
  ): BuiltinProvider<Kind> {
    return {
      name: definition.name,
      kind: definition.kind,
      protocols: definition.protocols,
      connect: async request => definition.connect(accepted(definition.protocols, request))
    };
  }
};
