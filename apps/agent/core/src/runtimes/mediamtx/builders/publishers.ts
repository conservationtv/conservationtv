import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import type { PublishedRendition } from '@conservationtv/studio-sdk';
import type { MediamtxListening, MediamtxServing, MoqPublisher } from '../config.ts';
import { loopback } from '../ports.ts';

/**
 * A rendition's publisher: the moq CLI pulling it from this MediaMTX over RTMP, as a reader on loopback, which needs no
 * token (auth.ts), and publishing it as its own broadcast. MediaMTX runs it directly: none of its arguments has a space.
 */
function publisherCommand(publisher: MoqPublisher, rendition: PublishedRendition, moq: string, rtmp: number) {
  const publish = [moq, '--connect', publisher.connect, 'import', '--broadcast', rendition.rendition];
  return [...publish, 'rtmp', '--connect', `rtmp://${loopback(rtmp)}/${rendition.path}`].join(' ');
}

/**
 * Each rendition of each publisher, on a path of its own that runs it while MediaMTX runs, restarting it whenever it
 * exits: each is a broadcast, and a CLI, of its own. Nobody reads the path, and its name says whose it is.
 */
export const publishers = new MediamtxConfigBuilder<MediamtxListening & MediamtxServing>((serving, config) => {
  if (serving.publishing === undefined) return;
  const { moq } = serving.publishing;
  const { rtmp } = serving.ports;
  for (const publisher of serving.publishing.publishers) {
    for (const rendition of publisher.renditions) {
      config.paths[`_publish/${publisher.exposureId}/${rendition.rendition}`] = {
        runOnInit: publisherCommand(publisher, rendition, moq, rtmp),
        runOnInitRestart: true
      };
    }
  }
});
