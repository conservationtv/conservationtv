import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import { renderYaml } from '../../mediamtx/config.ts';

// A stream a MediaMTX gateway delivers, pulled into the program MediaMTX by a MediaMTX of the relay's own: the agent's
// pinned binary, with a config of its own in the relay's folder, and every server of its off, so it listens on nothing.
// Its one path pulls the gateway's RTSP(S) or RTMP(S) URL and forwards what it gets, as it is, to the stream's input
// path of the program MediaMTX (`inputs/<stream>`), as OBS reads it:
//
//   gateway ──rtsp(s)/rtmp(s), ?jwt=──▶ MediaMTX (the relay's) ──forward, rtmp──▶ program MediaMTX inputs/<stream>
//
// The program MediaMTX's config never changes for it: the relay publishes into the input pattern like `moq export`
// does. The URL, token and all, is given in the environment (`MTX_PATHS_PULL_SOURCE`), never in the config file or
// the command line, and MediaMTX logs a source by its kind alone, so the token is in no file and no log. A gateway asks
// for the token only as a reader connects, so a pull keeps reading past its token's expiry; MediaMTX retries a source
// that drops by itself, every few seconds, with the URL it started with, which works until the token expires. Checked
// by hand against MediaMTX v1.21.2 on macOS: RTSP and RTMP sources carrying `?jwt=` to an HTTP-authenticated
// MediaMTX, which asked once per connection and never again while it stayed up; both tracks (H.264, AAC) forwarded;
// a dropped source and a restarted program MediaMTX both recovered by themselves; a refused token logged as `401
// (Unauthorized)` or `authentication failed`, with no URL.

/** The pull's one path. MediaMTX reads a path's settings from the environment by its name, upper case. */
const PULL_PATH = 'pull';

/** Where the pull's source URL is given: MediaMTX's setting for its one path's `source`. */
export const PULL_SOURCE_VARIABLE = `MTX_PATHS_${PULL_PATH.toUpperCase()}_SOURCE`;

/** What the pull forwards to: the input's path on the program MediaMTX, as an RTMP URL. */
interface Pulling {
  destination: string;
}

/**
 * Nothing listening, no control API or metrics page: only the path, pulling over TCP (RTSP's interleaved transport,
 * which a gateway across a router or on the internet always passes), forwarding to `destination`.
 */
const pullConfig = new MediamtxConfigBuilder<Pulling>(({ destination }, config) => {
  config.logLevel = 'info';
  config.logDestinations = ['stdout'];
  config.writeQueueSize = 4096;
  config.api = false;
  config.metrics = false;
  config.pprof = false;
  config.playback = false;
  config.rtsp = false;
  config.rtmp = false;
  config.hls = false;
  config.webrtc = false;
  config.srt = false;
  config.moq = false;
  config.paths[PULL_PATH] = { rtspTransport: 'tcp', forward: [{ dest: destination }] };
});

/** The pull's config file's text, forwarding to `destination`. */
export function pullYaml(destination: string): Promise<string> {
  return renderYaml(pullConfig, { destination });
}
