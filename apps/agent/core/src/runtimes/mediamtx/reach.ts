import { MEDIAMTX_AUTH_PATH } from './auth.ts';
import { loopback, type MediamtxPorts } from './ports.ts';

// Where the agent and MediaMTX reach each other, and where MediaMTX reaches its own servers. Everything that talks to
// MediaMTX, or that MediaMTX talks to, takes its address from here rather than working it out from the ports, so how
// they reach each other is decided once, by whoever puts the agent together (app.ts). Today MediaMTX is the agent's own
// child on the same machine, so every address is on loopback (`localReach`).

export interface MediamtxReach {
  /** MediaMTX's control API, as the agent calls it, such as `http://127.0.0.1:9997`. */
  api: string;
  /** MediaMTX's metrics page, as the agent reads it, such as `http://127.0.0.1:9998/metrics`. */
  metrics: string;
  /** Where the agent's server answering MediaMTX's authentication requests listens, such as `127.0.0.1:9996`. */
  authListen: string;
  /** Where MediaMTX asks the agent about authentication, such as `http://127.0.0.1:9996/mediamtx/auth`. */
  authCallback: string;
  /** MediaMTX's RTSP server, as its own paths read one another, such as `rtsp://127.0.0.1:8554`. */
  rtsp: string;
  /** MediaMTX's RTMP server, as the publishers it runs read renditions, such as `rtmp://127.0.0.1:1935`. */
  rtmp: string;
}

/** How the agent and a MediaMTX on the same machine, listening on `ports`, reach each other: all on loopback. */
export function localReach(ports: MediamtxPorts): MediamtxReach {
  return {
    api: `http://${loopback(ports.api)}`,
    metrics: `http://${loopback(ports.metrics)}/metrics`,
    authListen: loopback(ports.auth),
    authCallback: `http://${loopback(ports.auth)}${MEDIAMTX_AUTH_PATH}`,
    rtsp: `rtsp://${loopback(ports.rtsp)}`,
    rtmp: `rtmp://${loopback(ports.rtmp)}`
  };
}
