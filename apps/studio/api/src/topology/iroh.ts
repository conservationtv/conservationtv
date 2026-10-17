import { z } from 'zod';
import type { AuthenticatedDevice } from '../middleware/device.ts';

// How a device starts an iroh session: which relays its endpoint uses, whether it serves (an agent) or dials (the CLI,
// a browser). Devices ask for it signed, each time they bind an endpoint, so this is where relay credentials and their
// leases are issued per device. For now every organisation uses n0's public relays.

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

/** n0's public relays. */
export interface N0Relays {
  type: 'n0';
}

/** The organisation's own relays. */
export interface CustomRelays {
  type: 'custom';
  relays: Relay[];
}

export type Relays = N0Relays | CustomRelays;

export interface IrohSession {
  relays: Relays;
}

/** The iroh session the device starts now. */
export function irohSession(_device: AuthenticatedDevice): IrohSession {
  return { relays: { type: 'n0' } };
}
