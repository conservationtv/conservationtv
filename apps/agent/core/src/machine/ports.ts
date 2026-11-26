import { createSocket } from 'node:dgram';
import { type AddressInfo, createServer } from 'node:net';

// Whether a port on this machine is free for a server about to listen on it, and a free one when it is not: for the
// MediaMTXs the agent runs (gateway/streams/chosen.ts, output/obs/program.ts), checked just before each is started.
//
// A port is tried as the server will bind it. One on every interface, as MediaMTX's `:<port>` is, binds IPv6's
// wildcard taking IPv4's too (Go's dual stack, on macOS, Linux and Windows alike); it is free only if that, IPv4's
// wildcard and IPv4's loopback each bind, one after another, since a program holding any of them would fail the server
// or take some of its connections (the agent's own, on loopback, among them). A machine without IPv6 skips that one,
// as Go does. Node binds with the same options Go does (SO_REUSEADDR for TCP on Unix only, nothing for UDP), so where
// one can bind, so can the other. Checking then starting can still lose a race to another program: whoever starts the
// server tries again (Run's `prepare`, converge's process).

export type Transport = 'tcp' | 'udp';
/** Where a server listens: on loopback alone, or on every interface. */
export type Scope = 'loopback' | 'any';

/** How a server listens on its port, and whether it takes the next one too, from an even one: RTP's RTCP, say. */
export interface PortUse {
  transport: Transport;
  scope: Scope;
  pair?: boolean;
}

/** Where a port is chosen from: one an operator set, used as given, or else the first free of `preferred`. */
export interface PortWish {
  pinned?: number;
  preferred: readonly number[];
}

/** A server to choose a port for: its role, how it listens, and where its port is chosen from. */
export interface PortWanted<Role extends string> {
  role: Role;
  use: PortUse;
  wish: PortWish;
}

export interface ChooseOptions {
  /** Ports not to choose but for a pin: those a server could not bind as it last started, say. */
  avoid?: ReadonlySet<number>;
  /** Who pins a port, as the failure to have one says; none if nothing may pin one. */
  pinnedBy?: string;
}

/** A server's port that is not the one it wanted first: taken, or not bound when it was last tried. */
export interface PortMove<Role extends string> {
  role: Role;
  wanted: number;
  chosen: number;
}

export interface PortChoice<Role extends string> {
  /** The port chosen for `role`. */
  port(role: Role): number;
  moved: PortMove<Role>[];
}

/** The hosts a server listening on `scope` binds, tried in turn. */
const HOSTS = {
  loopback: ['127.0.0.1'],
  any: ['::', '0.0.0.0', '127.0.0.1']
} as const satisfies Record<Scope, readonly string[]>;

/** What binding IPv6's wildcard fails with where the machine has no IPv6. */
const NO_IPV6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT']);

/** How many ports the system offers are tried for one server before giving up. */
const OFFERS = 32;

const MAX_PORT = 65_535;

/** A bind that succeeded, on the port it says: the system's choice, for 0. */
interface BoundPort {
  state: 'bound';
  port: number;
}

/** A bind that failed: the port is taken, or the machine has no IPv6. */
interface Unbound {
  state: 'taken' | 'unsupported';
}

/** What binding once said. */
type Bound = BoundPort | Unbound;

function failed(host: string, error: NodeJS.ErrnoException): Bound {
  return host === '::' && NO_IPV6.has(error.code ?? '') ? { state: 'unsupported' } : { state: 'taken' };
}

function bindTcp(host: string, port: number): Promise<Bound> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(failed(host, error)));
    server.listen({ host, port, ipv6Only: false, exclusive: true }, () => {
      // SAFETY: a TCP server listening on a host and port has an address and port, never a pipe's name.
      const address = server.address() as AddressInfo;
      server.close(() => resolve({ state: 'bound', port: address.port }));
    });
  });
}

function bindUdp(host: string, port: number): Promise<Bound> {
  return new Promise(resolve => {
    const socket = createSocket({ type: host.includes(':') ? 'udp6' : 'udp4', ipv6Only: false });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      try {
        socket.close();
      } catch {
        // Never bound.
      }
      resolve(failed(host, error));
    });
    socket.bind({ port, address: host, exclusive: true }, () => {
      const address = socket.address();
      socket.close(() => resolve({ state: 'bound', port: address.port }));
    });
  });
}

function bind(transport: Transport, host: string, port: number): Promise<Bound> {
  return transport === 'tcp' ? bindTcp(host, port) : bindUdp(host, port);
}

/** Whether a server could listen on `port` for `transport` on `scope` now. */
export async function portFree(port: number, transport: Transport, scope: Scope): Promise<boolean> {
  for (const host of HOSTS[scope]) {
    const bound = await bind(transport, host, port);
    if (bound.state === 'taken') return false;
  }
  return true;
}

/** A port the system offers for `transport` on `scope`: nothing listens on it, though it is not yet checked as a server would bind it. */
async function offered(transport: Transport, scope: Scope): Promise<number> {
  for (const host of HOSTS[scope]) {
    const bound = await bind(transport, host, 0);
    if (bound.state === 'bound') return bound.port;
  }
  throw new Error(`This machine offers no ${transport.toUpperCase()} port to listen on`);
}

/** The ports a server takes from `port`: it, and the next for a pair. */
function portsFrom(port: number, use: PortUse): number[] {
  return use.pair === true ? [port, port + 1] : [port];
}

/** The ports claimed so far in one choice, so no two servers share one, and those to keep off. */
class Claims {
  private readonly claimed = new Set<number>();

  constructor(private readonly avoid: ReadonlySet<number>) {}

  /** `pinned`, as given, or a failure naming it if it is not free. */
  async pin(role: string, pinned: number, use: PortUse, pinnedBy = 'its configuration'): Promise<number> {
    if (!(await this.fits(pinned, use))) {
      throw new Error(`The ${role} port ${pinned}, set by ${pinnedBy}, is in use by another program`);
    }
    return this.claim(pinned, use);
  }

  /** The first of `preferred` that is free, else one the system offers that is; none in `avoid`. */
  async pick(role: string, use: PortUse, preferred: readonly number[]): Promise<number> {
    for (const candidate of preferred) {
      if (await this.usable(candidate, use)) return this.claim(candidate, use);
    }
    for (let offer = 0; offer < OFFERS; offer++) {
      const candidate = await offered(use.transport, use.scope);
      const port = use.pair === true ? candidate - (candidate % 2) : candidate;
      if (await this.usable(port, use)) return this.claim(port, use);
    }
    throw new Error(`No free port was found for ${role}`);
  }

  private async usable(port: number, use: PortUse): Promise<boolean> {
    return !this.avoid.has(port) && (await this.fits(port, use));
  }

  /** Whether `port` (a pair's even one) and its pair's next are in range, unclaimed, and free. */
  private async fits(port: number, use: PortUse): Promise<boolean> {
    if (use.pair === true && port % 2 !== 0) return false;
    const ports = portsFrom(port, use);
    if (ports.some(each => each < 1 || each > MAX_PORT || this.claimed.has(each))) return false;
    for (const each of ports) {
      if (!(await portFree(each, use.transport, use.scope))) return false;
    }
    return true;
  }

  private claim(port: number, use: PortUse): number {
    for (const each of portsFrom(port, use)) this.claimed.add(each);
    return port;
  }
}

/**
 * Each server's port: a pinned one as given, failing if it is not free; else the first of its preferred that is free
 * and not avoided; else one the system offers. No two share a port, a pair's second included.
 */
export async function choosePorts<Role extends string>(
  wanted: readonly PortWanted<Role>[],
  options: ChooseOptions
): Promise<PortChoice<Role>> {
  const claims = new Claims(options.avoid ?? new Set());
  const ports = new Map<Role, number>();
  // Pins first, so no other server takes one; then the rest in order, each said to have moved when it is not on the
  // first port it preferred.
  for (const { role, use, wish } of wanted) {
    if (wish.pinned !== undefined) ports.set(role, await claims.pin(role, wish.pinned, use, options.pinnedBy));
  }
  const moved: PortMove<Role>[] = [];
  for (const { role, use, wish } of wanted) {
    if (ports.has(role)) continue;
    const chosen = await claims.pick(role, use, wish.preferred);
    ports.set(role, chosen);
    const [first] = wish.preferred;
    if (first !== undefined && first !== chosen) moved.push({ role, wanted: first, chosen });
  }
  const port = (role: Role) => {
    const chosen = ports.get(role);
    if (chosen === undefined) throw new Error(`No port was chosen for ${role}`);
    return chosen;
  };
  return { port, moved };
}
