import { createSocket } from 'node:dgram';
import os from 'node:os';
import { useStudio } from '../studio.ts';

// Where the agent can be reached on its own network, found on its interfaces and reported to the studio API
// (`deviceAddresses.replace`), which keeps the latest report against the agent's device. That is what lets anything
// else, a DNS record for the gateway say, point readers on the network at the agent.
//
// Every address an interface carries is reported except those useless off this machine: loopback, and link-local.
// The one the default route leaves by is `preferred`: the kernel says which when a UDP socket is connected to an
// address on the internet, which sends nothing. On a machine with several networks, cameras on one and the internet
// on another, that may not be the interface readers use, which is why the rest are reported too.

/** An address the agent found on one of its interfaces. */
export interface LanAddress {
  address: string;
  /** The interface, as the machine names it: `eth0`, `en0`, `Ethernet`. */
  interface: string;
  /** Whether the default route leaves by it. */
  preferred: boolean;
}

/** An address on the internet, for the kernel to route to. Nothing is sent to it. */
const ROUTE_PROBE = { address: '1.1.1.1', port: 53 };

/** IPv6 link-local, `fe80::/10`, which Node reports with its scope ID too (`fe80::1%en0`). */
const LINK_LOCAL_V6 = /^fe[89ab]/iu;

/** Whether an address of one of this machine's interfaces could reach it from another machine on the same network. */
function reachable(entry: os.NetworkInterfaceInfo): boolean {
  if (entry.internal) return false;
  if (entry.family === 'IPv4') return !entry.address.startsWith('169.254.');
  return !LINK_LOCAL_V6.test(entry.address);
}

/** The address the default route leaves by, or undefined on a machine with no route to the internet. */
export function defaultRouteAddress(): Promise<string | undefined> {
  return new Promise(resolve => {
    const socket = createSocket('udp4');
    socket.once('error', () => {
      socket.close();
      resolve(undefined);
    });
    socket.connect(ROUTE_PROBE.port, ROUTE_PROBE.address, () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}

/** Every address this machine can be reached at from its network, the default route's first. */
export async function lanAddresses(): Promise<LanAddress[]> {
  const preferred = await defaultRouteAddress();
  const found: LanAddress[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!reachable(entry)) continue;
      found.push({ address: entry.address, interface: name, preferred: entry.address === preferred });
    }
  }
  return found.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.address.localeCompare(b.address));
}

/** Reports the agent's addresses to the studio API (`useStudio()`), each time they differ from what it last accepted. */
export class AddressReporter {
  /** The addresses last accepted, as JSON, so an unchanged set is not reported again. */
  private accepted: string | undefined = undefined;

  /** Report `addresses` unless they are what was last accepted. Throws if that fails, to be tried again next time. */
  async submit(addresses: LanAddress[]): Promise<void> {
    const serialised = JSON.stringify(addresses);
    if (serialised === this.accepted) return;
    const studio = useStudio();
    await studio.handshake();
    const result = await studio.deviceAddresses.replace.v1({ addresses });
    if (result instanceof Error) throw result;
    this.accepted = serialised;
  }

  /** Forget what was accepted, so the next submission reports whatever it finds. */
  clear(): void {
    this.accepted = undefined;
  }
}
