import { connect as dial } from 'node:net';
import { join } from 'node:path';
import type { CtvStream } from '@conservationtv/shows/ctv-stream';
import { AttachedProcess } from '@conservationtv/converge/process';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import type { ObsHandle, ObsInput, ObsSourcePlugin } from '@strangecyan/vignette/obs';

// The `ctv-stream` source kind (packages/shows) in OBS. A stream is read over MoQ as the agent's device, which the
// studio API admits for what its show places (apps/studio/api/src/gateways/connect.ts), and played by a stock media
// source from RTMP that a `moq` CLI serves on a local port:
//
//   moq --connect <relay?jwt=…> --broadcast <name> export rtmp --listen 127.0.0.1:<port>
//
// The session (a relay URL carrying a short-lived token) is the agent's own, asked for when the source is placed and
// again before it expires. A new one restarts `moq` on the same port, so the OBS input never changes and OBS reconnects
// by itself, after a short gap. Each `moq` is the agent's child (converge's AttachedProcess), restarted if it dies.

const logger = getLogger(['agent', 'obs', 'ctv-stream']);

/** How long before a session expires to ask for the next, and the soonest to ask again after a failure. */
const RENEW_BEFORE_MS = 10 * 60_000;
const RETRY_MS = 60_000;

/** How stale a group may get before `moq` skips it: RTMP is unpaced, so this bounds the buffering. */
const MAX_AGE = '500ms';

type CtvStreamSource = Parameters<NonNullable<ObsSourcePlugin<typeof CtvStream>['create']>>[0];
type CtvStreamProps = CtvStreamSource['props'];

/** What the plugin needs from the runtime: the studio API, as the device, the `moq` to run, and where relays live. */
export interface CtvStreamObsOptions {
  studio: Client;
  /** The installed `moq` CLI. */
  moq: string;
  /** A folder of the plugin's own, for each relay's log and pidfile. */
  directory: string;
}

/** Plays `ctv-stream` sources in vignette's OBS target. */
export function ctvStreamObs(options: CtvStreamObsOptions): ObsSourcePlugin<typeof CtvStream> {
  return {
    kind: 'ctv-stream',
    async create(source, context) {
      const address = `127.0.0.1:${String(await context.port())}`;
      const relay = new Relay(options, source.id, address);
      context.signal.addEventListener('abort', () => void relay.stop(), { once: true });
      await relay.follow(source.props);
      return {
        get input() {
          return relayInput(relay.broadcast, address);
        },
        update: next => relay.follow(next.props),
        dispose: () => relay.stop()
      } satisfies ObsHandle<typeof CtvStream>;
    }
  };
}

/** A media source playing what the relay serves; it reconnects quickly when the relay restarts. */
function relayInput(broadcast: string, address: string): ObsInput {
  return {
    kind: 'ffmpeg_source',
    settings: {
      input: `rtmp://${address}/live/${encodeURIComponent(broadcast)}`,
      is_local_file: false,
      reconnect_delay_sec: 1,
      restart_on_activate: false,
      close_when_inactive: false
    },
    // Muted, as the studio's preview is, until a show says how its sound is mixed.
    muted: true
  };
}

/** Where to read an exposure: the relay URL, carrying its token as `?jwt=`, the broadcast, and when it expires. */
interface Session {
  url: string;
  broadcast: string;
  expiresAt: number;
}

/** A read session for the exposure, as the device. Throws if the API refuses it, or offers anything but MoQ. */
async function readSession(studio: Client, props: CtvStreamProps): Promise<Session> {
  const connection = await studio.organisations.streams.exposures.connect.v1({
    id: props.organisationId,
    streamId: props.streamId,
    exposureId: props.exposureId,
    action: 'read',
    protocol: 'moq'
  });
  if (connection instanceof Error) throw connection;
  if (!('relay' in connection)) throw new Error(`Exposure ${props.exposureId} is not read by MoQ`);
  const url = new URL(connection.path, connection.relay);
  if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
  const expiresAt = connection.expiresAt === undefined ? Infinity : Date.parse(connection.expiresAt);
  return { url: url.href, broadcast: connection.broadcast, expiresAt };
}

/** Whether something accepts TCP connections at `address`: the relay, once its RTMP listener is up. */
function listening(address: string, signal: AbortSignal): Promise<boolean> {
  const [host = '127.0.0.1', port = '0'] = address.split(':');
  return new Promise(resolve => {
    const socket = dial({ host, port: Number(port), signal });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * One source's relay: `moq` serving the exposure's broadcast as RTMP at `address`, from the latest session, which it
 * renews before it expires.
 */
class Relay {
  private readonly process: AttachedProcess;
  private props: CtvStreamProps | undefined = undefined;
  private session: Session | undefined = undefined;
  private renewal: ReturnType<typeof setTimeout> | undefined = undefined;
  private readonly stopping = new AbortController();

  constructor(
    private readonly options: CtvStreamObsOptions,
    private readonly sourceId: string,
    private readonly address: string
  ) {
    this.process = new AttachedProcess(join(options.directory, sourceId), {
      name: 'moq',
      probe: signal => listening(address, signal),
      readyTimeoutMs: 30_000
    });
  }

  /** The broadcast it serves, which the input names. Known once it has followed a source. */
  get broadcast(): string {
    return this.session?.broadcast ?? '';
  }

  /** Serve the exposure `props` name: with a new session if it is another exposure, as it is the first time. */
  async follow(props: CtvStreamProps): Promise<void> {
    const same = this.props?.exposureId === props.exposureId && this.props.streamId === props.streamId;
    this.props = props;
    if (same && this.session !== undefined) return;
    await this.renew();
  }

  /** Ask for a session and restart `moq` with it, then schedule the next; a failure is tried again a minute on. */
  private async renew(): Promise<void> {
    clearTimeout(this.renewal);
    const props = this.props;
    if (props === undefined || this.stopping.signal.aborted) return;
    try {
      const session = await readSession(this.options.studio, props);
      await this.run(session);
      this.session = session;
      this.schedule(Math.max(session.expiresAt - Date.now() - RENEW_BEFORE_MS, RETRY_MS));
    } catch (error) {
      logger.error('The stream for {sourceId} is unavailable: {error}', { sourceId: this.sourceId, error });
      this.schedule(RETRY_MS);
      if (this.session === undefined) throw error;
    }
  }

  private schedule(delay: number): void {
    if (!Number.isFinite(delay)) return;
    this.renewal = setTimeout(() => void this.renew().catch(() => undefined), delay);
  }

  /** `moq` serving `session`: the same process while the session is the same, a new one on the same port when not. */
  private async run(session: Session): Promise<void> {
    const args = [
      ['--connect', session.url, '--broadcast', session.broadcast, 'export'],
      ['rtmp', '--listen', this.address, '--max-age', MAX_AGE]
    ].flat();
    await this.process.ensure(
      { key: session.url, binary: this.options.moq, args, env: { NO_COLOR: '1' } },
      this.stopping.signal
    );
  }

  async stop(): Promise<void> {
    clearTimeout(this.renewal);
    this.stopping.abort();
    await this.process.stop();
  }
}
