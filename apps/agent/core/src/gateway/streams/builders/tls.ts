import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { MediamtxServing } from '../config.ts';

/**
 * TLS with the gateway's certificate (tls.ts), for clients on the network, which reach MediaMTX by the certificate's
 * hostname. RTSP and RTMP keep their plain listeners beside the secure ones (`optional`): the moq CLI publishers read
 * renditions over plain RTMP on loopback, and a client on the network may still use plain protocols by address. HLS
 * and WebRTC are HTTP servers with one listener each, which is made HTTPS: browsers only take them from a secure
 * origin anyway. The hostname is added to WebRTC's, so its ICE candidates name it beside the addresses.
 */
export const tls = new MediamtxConfigBuilder<MediamtxServing>((serving, config) => {
  if (serving.tls === undefined) return;
  const { certificate, key, hostname } = serving.tls;
  config.rtspEncryption = 'optional';
  config.rtspServerCert = certificate;
  config.rtspServerKey = key;
  config.rtmpEncryption = 'optional';
  config.rtmpServerCert = certificate;
  config.rtmpServerKey = key;
  config.hlsEncryption = true;
  config.hlsServerCert = certificate;
  config.hlsServerKey = key;
  config.webrtcEncryption = true;
  config.webrtcServerCert = certificate;
  config.webrtcServerKey = key;
  config.webrtcAdditionalHosts = [hostname];
});
