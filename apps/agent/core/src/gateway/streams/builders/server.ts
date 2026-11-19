import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxListening } from '../config.ts';

/**
 * Every server on its port (ports.ts), on every interface, as MediaMTX's own defaults are. The control API and metrics
 * page are the common step's (mediamtx/config.ts).
 */
export const server = new MediamtxConfigBuilder<MediamtxListening>(({ ports }, config) => {
  config.rtspAddress = `:${ports.rtsp}`;
  config.rtpAddress = `:${ports.rtp}`;
  config.rtcpAddress = `:${ports.rtcp}`;
  config.rtspsAddress = `:${ports.rtsps}`;
  config.srtpAddress = `:${ports.srtp}`;
  config.srtcpAddress = `:${ports.srtcp}`;
  config.rtmpAddress = `:${ports.rtmp}`;
  config.rtmpsAddress = `:${ports.rtmps}`;
  config.hlsAddress = `:${ports.hls}`;
  config.webrtcAddress = `:${ports.webrtc}`;
  config.webrtcLocalUDPAddress = `:${ports.webrtcUdp}`;
  config.srtAddress = `:${ports.srt}`;
});
