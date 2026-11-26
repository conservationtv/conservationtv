import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AttachedProcess, type Run } from '@conservationtv/converge/process';
import type { MediamtxApi } from '@conservationtv/mediamtx/api';
import { getLogger } from '@logtape/logtape';
import { moqPublishArgs } from '../../binaries/moq.ts';
import { PathHolds } from '../../mediamtx/hold.ts';
import type { MoqPublisher } from './config.ts';

const logger = getLogger(['agent', 'mediamtx', 'pushed']);

// The publishers of pushed paths (no source: a pushed stream's ingest, docs/shows.md), each run by the agent itself,
// as its own child, while someone publishes to its path. A camera's publisher can be MediaMTX's own, on a path of its
// own (builders/publishers.ts), because that path is nobody else's: a renewed token changes it, MediaMTX closes and
// makes it again, and only the CLI restarts. A pushed path is the encoder's: MediaMTX updates a path in place only for
// a few of its settings, and closes and makes it again, cutting off its publisher and every reader, for any other,
// such as a command naming a new token. So nothing about a pushed path's publisher is in that path's config but a hook
// (`runOnAvailable`) whose text never changes, the hold launcher (mediamtx/hold.ts), telling the agent the path is
// published for as long as it is:
//
//   encoder publishes <id>/live  ─▶  MediaMTX runs the hold launcher, which holds a request to the agent open
//                                      ▼
//   the agent runs  moq --broadcast <name> import rtmp --connect rtmp://…/<id>/live      (MOQ_CONNECT=<relay?jwt=…>)
//
// and stops it once the request closes, as MediaMTX stops the launcher when the encoder goes. A renewed token, or a
// publisher otherwise changed, restarts the CLI alone. The token is given in its environment, never on its command
// line. Every pushed path runs the hook, with a publisher or without, and its command is the same for as long as the
// hold server listens, which is for as long as MediaMTX runs: so a pushed path's config changes only with the path
// itself, never with its publisher, its token, or the publisher coming or going.
//
// A replaced stream key changes no config either: keys are checked by the agent's answers (auth.ts), which refuse the
// old key from the next configuration on, while an encoder already publishing with it carries on until it reconnects.

/** The processes' run, as its publisher and the CLI say: a changed one, as a renewed token is, is a new process. */
function runOf(publisher: MoqPublisher, moq: string, rtmp: string): Run {
  const args = moqPublishArgs(publisher.broadcast, `${rtmp}/${publisher.path}`);
  const env = { NO_COLOR: '1', MOQ_CONNECT: publisher.connect };
  const key = createHash('sha256')
    .update(JSON.stringify([moq, args, publisher.connect]))
    .digest('hex');
  return { key, binary: moq, args, env };
}

/** What the publishers are run with: the CLI. */
export interface PushedPublishing {
  moq: string;
  publishers: MoqPublisher[];
}

/**
 * Each pushed path's publisher, run while its path is published. `set` says which there are; MediaMTX says, through the
 * hold server, which paths are published.
 */
export class PushedPublishers {
  private readonly holds = new PathHolds(path => this.held(path));
  /** The publishers wanted, by the path each reads. */
  private wanted = new Map<string, MoqPublisher>();
  private publishing: Omit<PushedPublishing, 'publishers'> | undefined = undefined;
  /** How many hold each path now: MediaMTX may start a launcher before the last one's request has closed. */
  private readonly published = new Map<string, number>();
  /**
   * Each exposure's process, kept while it is wanted or still stopping: one for an exposure is only ever made once
   * the last for it has gone, as they share its folder and pidfile.
   */
  private readonly processes = new Map<string, AttachedProcess>();

  /**
   * @param rtmp Where MediaMTX's RTMP server is reached on this machine now (`reach.rtmp`, listening.ts), asked as each
   *   publisher starts: MediaMTX may have been started again on another port, which ends every publish there anyway.
   */
  constructor(
    private readonly directory: string,
    private readonly api: MediamtxApi,
    private readonly rtmp: () => string
  ) {}

  /** The hook every pushed path runs (`runOnAvailable`): the same until `close`, which comes with MediaMTX's stop. */
  command(node: string): Promise<string> {
    return this.holds.command(node, join(this.directory, 'available.mjs'));
  }

  /** Run these publishers while their paths are published, and no other. */
  set(publishing: PushedPublishing | undefined): void {
    this.publishing = publishing && { moq: publishing.moq };
    this.wanted = new Map((publishing?.publishers ?? []).map(publisher => [publisher.path, publisher]));
    this.sync();
  }

  /** Stop every publisher, and stop listening. */
  async close(): Promise<void> {
    this.set(undefined);
    await Promise.all([...this.processes.values()].map(process => process.stop()));
    await this.holds.close();
  }

  dispose(): void {
    this.holds.dispose();
    for (const process of this.processes.values()) process.dispose();
    this.processes.clear();
  }

  private held(path: string): () => void {
    this.published.set(path, (this.published.get(path) ?? 0) + 1);
    this.sync();
    return () => {
      const holding = (this.published.get(path) ?? 1) - 1;
      if (holding > 0) this.published.set(path, holding);
      else this.published.delete(path);
      this.sync();
    };
  }

  /** Each exposure's process running what it is wanted to while its path is published, and stopped otherwise. */
  private sync(): void {
    const running = new Map<string, Run>();
    const { publishing } = this;
    const rtmp = this.rtmp();
    for (const [path, publisher] of this.wanted) {
      if (publishing === undefined || !this.published.has(path)) continue;
      running.set(publisher.exposureId, runOf(publisher, publishing.moq, rtmp));
    }
    for (const [exposureId, process] of this.processes) {
      if (running.has(exposureId)) continue;
      // Forgotten once stopped, unless it is wanted again meanwhile: then it runs again, after the stop.
      void process.stop().then(() => {
        if (this.processes.get(exposureId) === process && !this.wants(exposureId)) this.processes.delete(exposureId);
      });
    }
    for (const [exposureId, run] of running) {
      let process = this.processes.get(exposureId);
      if (process === undefined) {
        process = this.attached(exposureId);
        this.processes.set(exposureId, process);
      }
      process.ensure(run, AbortSignal.timeout(30_000)).catch((error: Error) => {
        logger.error('Publishing {exposureId} from its pushed path failed: {error}', { exposureId, error });
      });
    }
  }

  /** Whether the exposure's publisher is wanted to run now. */
  private wants(exposureId: string): boolean {
    if (this.publishing === undefined) return false;
    for (const [path, publisher] of this.wanted) {
      if (publisher.exposureId === exposureId && this.published.has(path)) return true;
    }
    return false;
  }

  /**
   * The exposure's process: answering while its path is available, which it always is as the CLI starts, so a stale
   * pidfile's pid is only taken for one while its path is published.
   */
  private attached(exposureId: string): AttachedProcess {
    const path = () => [...this.wanted.values()].find(publisher => publisher.exposureId === exposureId)?.path;
    const probe = async (signal: AbortSignal) => {
      const name = path();
      if (name === undefined) return false;
      const { data } = await this.api.pathsGet({ name }, { signal });
      return data?.available === true;
    };
    return new AttachedProcess(join(this.directory, exposureId), { name: 'moq', probe });
  }
}
