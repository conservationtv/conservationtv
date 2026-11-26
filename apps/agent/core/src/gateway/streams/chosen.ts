import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { choosePorts, type PortMove, type PortWanted } from '../../machine/ports.ts';
import {
  DEFAULT_MEDIAMTX_PORTS,
  MediamtxPortPinsSchema,
  type MediamtxPortPins,
  type MediamtxPorts,
  PORT_ROLES,
  PORT_USES,
  type PortRole
} from './ports.ts';

// The gateway MediaMTX's ports, chosen before each start of it as ports.ts says: pinned ones as given, the rest as last
// time if they are free, else MediaMTX's own, else any free, and remembered in the gateway's directory for the next.

/** Where the ports chosen last time are kept. */
const REMEMBERED_FILE = 'ports.json';

/** Who pins a port, as a failure to have it says. */
const PINNED_BY = "the agent's configuration (AGENT_MEDIAMTX_PORTS)";

/**
 * What MediaMTX logs when it cannot listen on a port, such as `listen tcp :8554: bind: address already in use`, or
 * Windows's wording of it after `bind:`.
 */
const BIND_FAILURE = /listen (?:tcp|udp)[46]? \S*:(\d+): bind: [^\r\n]*/gu;

/** How much of MediaMTX's log from a start on says whether it could listen: it binds everything as it starts. */
const STARTING_LOG_BYTES = 64 * 1024;

export interface ChosenPorts {
  ports: MediamtxPorts;
  /** The roles not on the port they wanted: last time's, or MediaMTX's own. */
  moved: PortMove<PortRole>[];
}

/** The ports chosen last time, as far as they can still be read. */
export async function rememberedPorts(directory: string): Promise<MediamtxPortPins> {
  const text = await readFile(join(directory, REMEMBERED_FILE), 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const remembered = MediamtxPortPinsSchema.safeParse(JSON.parse(text));
    return remembered.success ? remembered.data : {};
  } catch {
    return {};
  }
}

/**
 * The ports to start MediaMTX on, with `pins` as given and none of `avoid` (those it could not bind last time) for the
 * rest, remembered for the next start. Throws if a pinned port is in use.
 */
export async function chooseMediamtxPorts(
  directory: string,
  pins: MediamtxPortPins,
  avoid: ReadonlySet<number>
): Promise<ChosenPorts> {
  const remembered = await rememberedPorts(directory);
  const wanted = (role: PortRole): PortWanted<PortRole> => {
    const preferred = [...new Set([remembered[role], DEFAULT_MEDIAMTX_PORTS[role]])].filter(port => port !== undefined);
    return { role, use: PORT_USES[role], wish: { pinned: pins[role], preferred } };
  };
  const { port, moved } = await choosePorts(PORT_ROLES.map(wanted), { avoid, pinnedBy: PINNED_BY });
  const chosen: MediamtxPorts = {
    rtsp: port('rtsp'),
    rtp: port('rtp'),
    rtcp: port('rtp') + 1,
    rtsps: port('rtsps'),
    srtp: port('srtp'),
    srtcp: port('srtp') + 1,
    rtmp: port('rtmp'),
    rtmps: port('rtmps'),
    hls: port('hls'),
    webrtc: port('webrtc'),
    webrtcUdp: port('webrtcUdp'),
    srt: port('srt'),
    api: port('api'),
    metrics: port('metrics'),
    auth: port('auth')
  };
  if (JSON.stringify(chosen) !== JSON.stringify(remembered)) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, REMEMBERED_FILE), JSON.stringify(chosen));
  }
  return { ports: chosen, moved };
}

/** Where a log ends now: where what a process started next says begins. */
export async function logEnd(log: string): Promise<number> {
  const stats = await stat(log).catch(() => undefined);
  return stats?.size ?? 0;
}

/** Each port MediaMTX said it could not listen on as it started, logging from `from` on, and what it said. */
export async function bindFailures(log: string, from: number): Promise<Map<number, string>> {
  const handle = await open(log, 'r').catch(() => undefined);
  if (handle === undefined) return new Map();
  try {
    const buffer = Buffer.alloc(STARTING_LOG_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, STARTING_LOG_BYTES, from);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return new Map([...text.matchAll(BIND_FAILURE)].map(match => [Number(match[1]), match[0]]));
  } finally {
    await handle.close();
  }
}
