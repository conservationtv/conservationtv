import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxListening } from '../config.ts';
import { loopback } from '../ports.ts';

/**
 * Logs to stdout, which the runtime sends to its log file. Every server on its port (ports.ts): the control API and
 * metrics page on loopback, the rest on every interface, as MediaMTX's own defaults are.
 */
export const server = new MediamtxConfigBuilder<MediamtxListening>(({ ports }, config) => {
  config.logLevel = 'info';
  config.logDestinations = ['stdout'];
  config.api = true;
  config.apiAddress = loopback(ports.api);
  config.metrics = true;
  config.metricsAddress = loopback(ports.metrics);
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
