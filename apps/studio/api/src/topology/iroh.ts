import { z } from 'zod';
import { leaseEndpoint, type IrohLease } from '../gatekeeper/leases.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { useServices } from '../services.ts';

// How a device starts an iroh session: the relay its endpoint uses, whether it serves (an agent) or dials (the CLI, a
// browser). Devices ask for it signed, each time they bind an endpoint, so this is where each device's endpoint is
// leased on the relay, when the deployment's relay admits only leased endpoints (src/gatekeeper/leases.ts).
//
// Every device gets the same single relay. So an agent's address is always its endpoint ID at that relay: devices
// bind without address lookup and dial by relay URL, and nothing has to be published or registered.
//
// TODO: Assign a working, nearby relay per organisation rather than one for the deployment, kept on the organisation
//   so every session in it agrees. Fail over when it stops working, decided from trusted devices' reports (agents,
//   through `reports.submit`) of being unable to reach it from more than one network, with this API's own probe as a
//   cross-check, and fail back only once it has been healthy for a while. Sessions would then say when to ask again
//   (`refreshAfter`) and which assignment they carry (an `epoch`), so devices notice a failover and swap relays.

/** One relay server, as iroh's `RelayConfig` describes it. Named, so hosts configuring relays can check them too. */
export const RelaySchema = z
  .object({
    url: z.url(),
    quicPort: z.number().int().positive().optional(),
    /** For relays that admit only the endpoints given a token. */
    authToken: z.string().optional()
  })
  .meta({ id: 'Relay' });
export type Relay = z.output<typeof RelaySchema>;

export interface IrohSession {
  /** The only relay the device's endpoint uses, and where it finds every other device. */
  relay: Relay;
  /** What admits the device's endpoint to the relay; absent when the relay admits every endpoint. */
  lease?: IrohLease;
}

/** The iroh session the device starts now, with its endpoint leased on the relay if the relay requires it. */
export async function irohSession(device: AuthenticatedDevice): Promise<IrohSession> {
  const services = useServices();
  const { IROH_RELAY_URL, GATEKEEPER_URL, GRANT_SIGNING_KEYS } = services.config;
  const relay = { url: IROH_RELAY_URL };
  if (GATEKEEPER_URL === undefined || GRANT_SIGNING_KEYS === undefined) return { relay };
  const lease = await leaseEndpoint(device, { url: GATEKEEPER_URL, keys: GRANT_SIGNING_KEYS });
  return { relay, lease };
}
