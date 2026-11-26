import { z } from 'zod';
import type { PortUse } from '../../machine/ports.ts';

// The ports the gateway MediaMTX listens on, chosen before each start of it (chosen.ts) and never while it runs:
//
//   - one the operator pins (the runner's `AGENT_MEDIAMTX_PORTS`, for a firewalled site or a Docker port mapping) is
//     used as given and never moved: if another program has it, that start fails, saying which, and is tried again;
//   - any other is the one used last time, remembered in the gateway's directory, else MediaMTX's own below; if that
//     is taken, or MediaMTX could not bind it the last time it started, another free one is chosen, remembered, and
//     said with a warning and a `mediamtx.port.moved` event. RTP and RTCP (and SRTP and SRTCP) are an even port and the
//     next. The three on loopback (the control API, the metrics page, and the agent's answers to MediaMTX's
//     authentication requests) are chosen the same way, but only the agent reaches them, so a move is only logged.
//
// The studio API is never told what they are by configuration: the agent registers where its servers actually listen
// (endpoints.ts), and `connect` hands out those. Everything on this machine that reaches MediaMTX reads where it
// listens now (listening.ts).

export const PortSchema = z.number().int().min(1).max(65_535);
export type Port = z.output<typeof PortSchema>;

const MEDIAMTX_PORT_FIELDS = {
  /** RTSP, and its RTP and RTCP over UDP: RTP's even, RTCP's the next. */
  rtsp: PortSchema,
  rtp: PortSchema,
  rtcp: PortSchema,
  /** RTSPS, and its SRTP and SRTCP over UDP, served beside RTSP once the gateway has a certificate. */
  rtsps: PortSchema,
  srtp: PortSchema,
  srtcp: PortSchema,
  rtmp: PortSchema,
  /** RTMPS, served beside RTMP once the gateway has a certificate. */
  rtmps: PortSchema,
  /** HLS, over HTTP, or HTTPS once the gateway has a certificate. */
  hls: PortSchema,
  /** WebRTC's HTTP server, for WHIP and WHEP, HTTPS once the gateway has a certificate, and its ICE over UDP. */
  webrtc: PortSchema,
  webrtcUdp: PortSchema,
  srt: PortSchema,
  /** The control API, on loopback. */
  api: PortSchema,
  /** The metrics page, on loopback. */
  metrics: PortSchema,
  /** Where the agent answers MediaMTX's authentication requests, on loopback. */
  auth: PortSchema
};

type Ports = Partial<Record<keyof typeof MEDIAMTX_PORT_FIELDS, number>>;

/** Whether no two of the ports given are the same. */
const distinct = (ports: Ports) => {
  const given = Object.values(ports).filter(port => port !== undefined);
  return new Set(given).size === given.length;
};

/** Whether a pair's ports, if either is given, are an even port and the next. */
const paired = (first: number | undefined, second: number | undefined) =>
  first === undefined && second === undefined
    ? true
    : first !== undefined && second !== undefined && first % 2 === 0 && second === first + 1;

/** Every port MediaMTX listens on. */
export const MediamtxPortsSchema = z
  .strictObject(MEDIAMTX_PORT_FIELDS)
  .refine(distinct, { message: 'Each port may be used once' })
  .refine(ports => paired(ports.rtp, ports.rtcp), { message: 'RTP needs an even port, and RTCP the next' })
  .refine(ports => paired(ports.srtp, ports.srtcp), { message: 'SRTP needs an even port, and SRTCP the next' });
export type MediamtxPorts = z.output<typeof MediamtxPortsSchema>;

/** The ports an operator pins, each used as given and never moved; a pair's two are given together. */
export const MediamtxPortPinsSchema = z
  .strictObject(MEDIAMTX_PORT_FIELDS)
  .partial()
  .refine(distinct, { message: 'Each port may be used once' })
  .refine(ports => paired(ports.rtp, ports.rtcp), { message: 'RTP needs an even port, and RTCP the next' })
  .refine(ports => paired(ports.srtp, ports.srtcp), { message: 'SRTP needs an even port, and SRTCP the next' });
export type MediamtxPortPins = z.output<typeof MediamtxPortPinsSchema>;

/** MediaMTX's own ports. */
export const DEFAULT_MEDIAMTX_PORTS: MediamtxPorts = {
  rtsp: 8554,
  rtp: 8000,
  rtcp: 8001,
  rtsps: 8322,
  srtp: 8004,
  srtcp: 8005,
  rtmp: 1935,
  rtmps: 1936,
  hls: 8888,
  webrtc: 8889,
  webrtcUdp: 8189,
  srt: 8890,
  api: 9997,
  metrics: 9998,
  auth: 9996
};

/**
 * How each server listens on its port (MediaMTX's `:<port>` is every interface), but RTCP's and SRTCP's, the port
 * after RTP's and SRTP's.
 */
export const PORT_USES = {
  rtsp: { transport: 'tcp', scope: 'any' },
  rtp: { transport: 'udp', scope: 'any', pair: true },
  rtsps: { transport: 'tcp', scope: 'any' },
  srtp: { transport: 'udp', scope: 'any', pair: true },
  rtmp: { transport: 'tcp', scope: 'any' },
  rtmps: { transport: 'tcp', scope: 'any' },
  hls: { transport: 'tcp', scope: 'any' },
  webrtc: { transport: 'tcp', scope: 'any' },
  webrtcUdp: { transport: 'udp', scope: 'any' },
  srt: { transport: 'udp', scope: 'any' },
  api: { transport: 'tcp', scope: 'loopback' },
  metrics: { transport: 'tcp', scope: 'loopback' },
  auth: { transport: 'tcp', scope: 'loopback' }
} as const satisfies Record<Exclude<keyof MediamtxPorts, 'rtcp' | 'srtcp'>, PortUse>;

/** A port chosen on its own: all but RTCP and SRTCP. */
export type PortRole = keyof typeof PORT_USES;

/** Every port chosen on its own, in the order they are chosen. */
export const PORT_ROLES: readonly PortRole[] = [
  'rtsp',
  'rtp',
  'rtsps',
  'srtp',
  'rtmp',
  'rtmps',
  'hls',
  'webrtc',
  'webrtcUdp',
  'srt',
  'api',
  'metrics',
  'auth'
];

/** Where on this machine a loopback-only server listens. */
export const loopback = (port: number) => `127.0.0.1:${port}`;
