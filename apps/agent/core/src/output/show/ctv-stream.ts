import type { CtvStream } from '@conservationtv/shows/ctv-stream';
import type { ObsInput, ObsSourcePlugin } from '@strangecyan/vignette/obs';
import type { InputRelays } from '../obs/inputs.ts';

// The `ctv-stream` source kind (packages/shows) in OBS: a stock media source reading the stream from the program
// MediaMTX, at `inputs/<stream>`, the path the `obs` runtime relays it to while something reads it (../obs/inputs.ts),
// as anything driving OBS from outside reads one. Which delivery is read behind that path is the relay's to ask the
// studio API (`organisations.streams.connect`), which admits the read for what the show places
// (apps/studio/api/src/gateways/connect.ts); the input never changes when the delivery does. A source moved to
// another stream is another path, so it has no `update`: vignette makes it afresh.
//
// The input carries the stream's sound (`audio: true`), so vignette's OBS target converges the source's audio channel
// on it (volume, mute, sync offset), and mutes it when the source has none (`audio={false}`). A stream placed only for
// its sound (a source without a picture) needs nothing different here: vignette places a pictureless source's input
// as an enabled 1×1 item outside the canvas, which OBS still mixes while its scene is on programme.

/**
 * FFmpeg's options for opening the relay, as OBS passes them on (`ffmpeg_options`): ask the relay to buffer as little
 * as it can (`rtmp_buffer`, in milliseconds), and decide the streams from the first packets rather than probing for
 * seconds. Checked against `moq export rtmp`, and against MediaMTX forwarding an RTSP or an RTMP pull (../obs/pull.ts):
 * H.264 and AAC are still both found. With `buffering_mb` 0, OBS also opens it with FFmpeg's `nobuffer` flag and keeps
 * no network buffer of its own.
 */
const FFMPEG_OPTIONS = 'rtmp_buffer=100 probesize=32768 analyzeduration=0';

/** Plays `ctv-stream` sources in vignette's OBS target, from the `obs` runtime's relays. */
export function ctvStreamObs(inputs: InputRelays): ObsSourcePlugin<typeof CtvStream> {
  return {
    kind: 'ctv-stream',
    create(source) {
      const url = inputs.url(source.props.streamId);
      return { input: relayInput(url) };
    }
  };
}

/**
 * A media source playing the input's path with as little delay as it can: no buffering of its own, FFmpeg asked for
 * none either, decoded in hardware where it can be. It reconnects quickly, as it must whenever its relay restarts on
 * renewing its session, and whenever MediaMTX restarts.
 */
function relayInput(url: string): ObsInput {
  return {
    kind: 'ffmpeg_source',
    settings: {
      input: url,
      is_local_file: false,
      buffering_mb: 0,
      ffmpeg_options: FFMPEG_OPTIONS,
      hw_decode: true,
      reconnect_delay_sec: 1,
      restart_on_activate: false,
      close_when_inactive: false
    },
    audio: true
  };
}
