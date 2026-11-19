import type { CtvStream } from '@conservationtv/shows/ctv-stream';
import type { ObsInput, ObsSourcePlugin } from '@strangecyan/vignette/obs';
import type { InputRelays } from '../obs/inputs.ts';

// The `ctv-stream` source kind (packages/shows) in OBS: a stock media source reading the exposure from the program
// MediaMTX, at the path the `obs` runtime relays it to while something reads it (../obs/inputs.ts), as anything
// driving OBS from outside reads one. The studio API admits the read for what the show places
// (apps/studio/api/src/gateways/connect.ts). A source moved to another exposure is another path, so it has no
// `update`: vignette makes it afresh.

/**
 * FFmpeg's options for opening the relay, as OBS passes them on (`ffmpeg_options`): ask the relay to buffer as little
 * as it can (`rtmp_buffer`, in milliseconds), and decide the streams from the first packets rather than probing for
 * seconds. Checked against `moq export rtmp`: H.264 and AAC are still both found. With `buffering_mb` 0, OBS also opens
 * it with FFmpeg's `nobuffer` flag and keeps no network buffer of its own.
 */
const FFMPEG_OPTIONS = 'rtmp_buffer=100 probesize=32768 analyzeduration=0';

/** Plays `ctv-stream` sources in vignette's OBS target, from the `obs` runtime's relays. */
export function ctvStreamObs(inputs: InputRelays): ObsSourcePlugin<typeof CtvStream> {
  return {
    kind: 'ctv-stream',
    create(source) {
      const { streamId, exposureId } = source.props;
      const url = inputs.url({ streamId, exposureId });
      return { input: relayInput(url) };
    }
  };
}

/**
 * A media source playing the input's path with as little delay as it can: no buffering of its own, FFmpeg asked for
 * none either, decoded in hardware where it can be. It reconnects quickly, as it must when its path is first written
 * and whenever MediaMTX restarts.
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
    // Muted, as the studio's preview is, until a show says how its sound is mixed.
    muted: true
  };
}
