import { MediamtxConfigBuilder, toYaml } from '@conservationtv/mediamtx';

// What every MediaMTX the agent runs is configured with, whichever it is: the gateway's (gateway/streams/config.ts) and
// the program MediaMTX's (output/obs/program.ts). Each assembles its config from builder steps, this one first. The
// per-stream pull (output/obs/pull.ts) has a config of its own that listens on nothing.
//
// Every listener MediaMTX opens is either off or on a port the agent chose, in each config: a server left to
// MediaMTX's defaults binds a port nobody checked, and a taken one stops MediaMTX starting at all. As of v1.21.2 its
// defaults listen on: the control API (:9997), metrics (:9998), pprof (:9999), playback (:9996), RTSP (:8554, RTSPS
// :8322), RTP/RTCP (:8000/:8001) and SRTP/SRTCP (:8004/:8005) over UDP, RTSP multicast (8002/8003, SRTP's 8006/8007),
// RTMP (:1935, RTMPS :1936), HLS (:8888), WebRTC (:8889, ICE over UDP :8189, over TCP off), SRT (:8890, UDP) and MoQ
// (:8892 over TCP and UDP, QUIC :8893, with a key it writes to its working directory). pprof, playback and MoQ are
// off here for all of them: the agent publishes MoQ with the moq CLI, never through MediaMTX's server. When MediaMTX
// is upgraded, read the new release's mediamtx.yml (packages/mediamtx/spec) for any listener it adds, and turn it off
// here or give it a port (gateway/streams/ports.ts, or the program's own).

/** Where a MediaMTX's control API and metrics page listen, on loopback. */
export interface MediamtxControlPorts {
  api: number;
  metrics: number;
}

/** What the common step needs: where the control API and metrics page listen. */
export interface MediamtxControl {
  ports: MediamtxControlPorts;
}

/**
 * Logs to stdout, which each runtime sends to its log file. The control API and metrics page on loopback only, and no
 * pprof, playback or MoQ server. Each reader's queue of outgoing packets is 4096 rather than MediaMTX's 512.
 */
export const common = new MediamtxConfigBuilder<MediamtxControl>(({ ports }, config) => {
  config.logLevel = 'info';
  config.logDestinations = ['stdout'];
  config.writeQueueSize = 4096;
  config.api = true;
  config.apiAddress = `127.0.0.1:${String(ports.api)}`;
  config.metrics = true;
  config.metricsAddress = `127.0.0.1:${String(ports.metrics)}`;
  config.pprof = false;
  config.playback = false;
  config.moq = false;
});

/** The config file's text. Throws if the config is unfit to serve, naming what made it so. */
export async function renderYaml<P>(builder: MediamtxConfigBuilder<P>, params: P): Promise<string> {
  const { config, diagnostics } = await builder.render(params);
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`The MediaMTX config is unfit to serve: ${errors.map(error => error.message).join('; ')}`);
  }
  return toYaml(config);
}
