import { z } from 'zod';

// The ports MediaMTX listens on. Each defaults to MediaMTX's own, and any can be moved on the machine the agent runs on
// (the runner's `AGENT_MEDIAMTX_PORTS`), when another program has it or a second agent shares the machine. The studio
// API is never told what they are by configuration: the agent registers where its servers actually listen
// (endpoints.ts), and `connect` hands out those.

const PortSchema = z.number().int().min(1).max(65_535);
export type Port = z.output<typeof PortSchema>;

export const MediamtxPortsSchema = z
  .strictObject({
    /** RTSP, and its RTP and RTCP over UDP: RTP's even, RTCP's the next. */
    rtsp: PortSchema.default(8554),
    rtp: PortSchema.default(8000),
    rtcp: PortSchema.default(8001),
    /** RTSPS, and its SRTP and SRTCP over UDP, served beside RTSP once the gateway has a certificate. */
    rtsps: PortSchema.default(8322),
    srtp: PortSchema.default(8004),
    srtcp: PortSchema.default(8005),
    rtmp: PortSchema.default(1935),
    /** RTMPS, served beside RTMP once the gateway has a certificate. */
    rtmps: PortSchema.default(1936),
    /** HLS, over HTTP, or HTTPS once the gateway has a certificate. */
    hls: PortSchema.default(8888),
    /** WebRTC's HTTP server, for WHIP and WHEP, HTTPS once the gateway has a certificate, and its ICE over UDP. */
    webrtc: PortSchema.default(8889),
    webrtcUdp: PortSchema.default(8189),
    srt: PortSchema.default(8890),
    /** The control API, on loopback. */
    api: PortSchema.default(9997),
    /** The metrics page, on loopback. */
    metrics: PortSchema.default(9998),
    /** Where the agent answers MediaMTX's authentication requests, on loopback. */
    auth: PortSchema.default(9996)
  })
  .refine(ports => new Set(Object.values(ports)).size === Object.keys(ports).length, {
    message: 'Each port may be used once'
  })
  .refine(ports => ports.rtp % 2 === 0 && ports.rtcp === ports.rtp + 1, {
    message: 'RTP needs an even port, and RTCP the next'
  })
  .refine(ports => ports.srtp % 2 === 0 && ports.srtcp === ports.srtp + 1, {
    message: 'SRTP needs an even port, and SRTCP the next'
  });
export type MediamtxPorts = z.output<typeof MediamtxPortsSchema>;

/** MediaMTX's own ports. */
export const DEFAULT_MEDIAMTX_PORTS: MediamtxPorts = MediamtxPortsSchema.parse({});

/** Where on this machine a loopback-only server listens. */
export const loopback = (port: number) => `127.0.0.1:${port}`;
