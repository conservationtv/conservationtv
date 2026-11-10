import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { PublishedRendition } from '@conservationtv/studio-sdk';
import type { MediamtxListening, MediamtxServing, MoqPublisher } from '../config.ts';

/**
 * The moq CLI (`moq`, installed) pulling `source` over RTMP from a MediaMTX on the same machine, and publishing it as
 * `broadcast` at `connect`, the relay URL carrying its token. For MediaMTX to run directly (`runOnInit`): none of its
 * arguments has a space.
 */
export function moqPublishCommand(moq: string, connect: string, broadcast: string, source: string): string {
  return [moq, '--connect', connect, 'import', '--broadcast', broadcast, 'rtmp', '--connect', source].join(' ');
}

/**
 * A rendition's publisher: the moq CLI pulling it from this MediaMTX over RTMP (`rtmp`, from reach.ts), as a reader
 * on the same machine, which needs no token (auth.ts), and publishing it as its own broadcast.
 */
function publisherCommand(publisher: MoqPublisher, rendition: PublishedRendition, moq: string, rtmp: string) {
  return moqPublishCommand(moq, publisher.connect, rendition.rendition, `${rtmp}/${rendition.path}`);
}

/**
 * Each rendition of each publisher, on a path of its own that runs it while MediaMTX runs, restarting it whenever it
 * exits: each is a broadcast, and a CLI, of its own. Nobody reads the path, and its name says whose it is.
 */
export const publishers = new MediamtxConfigBuilder<MediamtxListening & MediamtxServing>((serving, config) => {
  if (serving.publishing === undefined) return;
  const { moq } = serving.publishing;
  const { rtmp } = serving.reach;
  for (const publisher of serving.publishing.publishers) {
    for (const rendition of publisher.renditions) {
      config.paths[`_publish/${publisher.exposureId}/${rendition.rendition}`] = {
        runOnInit: publisherCommand(publisher, rendition, moq, rtmp),
        runOnInitRestart: true
      };
    }
  }
});
