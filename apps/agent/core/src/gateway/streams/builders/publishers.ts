import { MediamtxConfigBuilder } from '@conservationtv/mediamtx';
import { moqPublishCommand } from '../../../binaries/moq.ts';
import type { MediamtxListening, MediamtxServing, MoqPublisher } from '../config.ts';

/**
 * An exposure's publisher: the moq CLI pulling its path from this MediaMTX over RTMP (`rtmp`, from reach.ts), as a
 * reader on the same machine, which needs no token (auth.ts), and publishing it as the broadcast readers watch.
 */
function publisherCommand(publisher: MoqPublisher, moq: string, rtmp: string) {
  return moqPublishCommand(moq, publisher.connect, publisher.broadcast, `${rtmp}/${publisher.path}`);
}

/**
 * Each publisher, on a path of its own that runs it while MediaMTX runs, restarting it whenever it exits. Nobody reads
 * the path, and its name says whose it is. One reading a pushed path (no source: a pushed stream's ingest, docs/shows.md)
 * is the agent's to run instead, while the path is published (pushed.ts): nothing of it is in the config, so neither a
 * renewed token nor a publisher coming or going changes the pushed path's, which would have MediaMTX close the path and
 * make it again, cutting off its encoder.
 */
export const publishers = new MediamtxConfigBuilder<MediamtxListening & MediamtxServing>((serving, config) => {
  if (serving.publishing === undefined) return;
  const { moq } = serving.publishing;
  const { rtmp } = serving.reach;
  const pushed = new Set(serving.paths.filter(path => path.source === undefined).map(path => path.name));
  for (const publisher of serving.publishing.publishers) {
    if (pushed.has(publisher.path)) continue;
    const command = publisherCommand(publisher, moq, rtmp);
    config.paths[`_publish/${publisher.exposureId}`] = { runOnInit: command, runOnInitRestart: true };
  }
});
