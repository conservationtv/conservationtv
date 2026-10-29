// The protocols a MediaMTX gateway is published to and read by (mediamtx.ts), and the URL schemes their servers have,
// shared with the endpoints agents register for them (src/services/gateway-endpoints.ts).

export const MEDIAMTX_PROTOCOLS = ['webrtc', 'rtsp', 'rtsps', 'rtmp', 'rtmps', 'hls'] as const;
export type MediamtxProtocol = (typeof MEDIAMTX_PROTOCOLS)[number];

/** The scheme each protocol's server URL may have: HLS and WebRTC are HTTP servers, with TLS or without. */
export const MEDIAMTX_SCHEMES = {
  webrtc: ['http:', 'https:'],
  rtsp: ['rtsp:'],
  rtsps: ['rtsps:'],
  rtmp: ['rtmp:'],
  rtmps: ['rtmps:'],
  hls: ['http:', 'https:']
} as const satisfies Readonly<Record<MediamtxProtocol, readonly string[]>>;
