import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { mediamtxCommand } from './command.ts';

// How a MediaMTX the agent runs tells it that one of its paths is in some state, for as long as it is: a hook
// (`runOnDemand` while a path is read, `runOnAvailable` while one is published) running a small Node script the agent
// writes, run by the agent's own Node, whose one request to the agent's hold server on loopback says which path
// (MediaMTX gives it `MTX_PATH`) and, by staying open, for how long. MediaMTX stops the hook when the state ends, which
// closes the request. A launcher also gives up its request once MediaMTX is gone (its parent changes): outside Windows,
// MediaMTX starts commands in their own process group and doesn't kill them when it dies, so a crashed MediaMTX's
// launchers would otherwise hold their paths forever.
//
// The command's text is the same for every path and for as long as the server listens: the agent's own state, such as
// a renewed token, never reaches MediaMTX's config through it, so a path whose hook it is never changes for it.

/** The launcher MediaMTX runs: one request to the hold server, held open until it is stopped. */
const LAUNCHER = `import { request } from 'node:http';
// Written by the conservation.tv agent (mediamtx/hold.ts): tells it, for as long as this runs, that MediaMTX's
// path MTX_PATH is held, and stops once MediaMTX, its parent, is gone.
const [port, secret] = process.argv.slice(2);
const path = process.env.MTX_PATH ?? '';
const held = request({ host: '127.0.0.1', port: Number(port), path: '/' + secret + '/' + path }, response => {
  response.resume();
  response.on('end', () => process.exit(0));
});
held.on('error', () => process.exit(1));
held.end();
const stop = () => {
  held.destroy();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) stop();
}, 1000).unref();
`;

/**
 * A path held: how to let go of it once its launcher's request closes; or `undefined` to refuse a path that is not
 * the agent's to hold.
 */
export type Hold = (path: string) => (() => void) | undefined;

/**
 * The hold server: each launcher's request holds its path, through `hold`, until it closes. Listens on loopback, on a
 * port of the system's choosing, from the first `command` until `close`.
 */
export class PathHolds {
  /** Keeps anything else on the machine from holding a path: it is only in the hook's command. */
  private readonly secret = randomBytes(18).toString('base64url');
  private server: Server | undefined = undefined;

  constructor(private readonly hold: Hold) {}

  /**
   * The command MediaMTX is to run for a held path: `node` running the launcher, written to `launcher`, which asks
   * this server. The same for as long as the server listens.
   */
  async command(node: string, launcher: string): Promise<string> {
    const port = await this.listen();
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, LAUNCHER);
    return mediamtxCommand(node, launcher, String(port), this.secret);
  }

  /**
   * Stop listening. Launchers' requests still held are cut: `close` alone waits for them, and one whose MediaMTX has
   * gone may never end its own.
   */
  async close(): Promise<void> {
    const { server } = this;
    this.server = undefined;
    if (server === undefined) return;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  dispose(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  /** The server, started once. */
  private async listen(): Promise<number> {
    if (this.server === undefined) {
      const server = createServer((request, response) => this.held(request, response));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      this.server = server;
    }
    // SAFETY: a server listening on TCP has an address of its own.
    return (this.server.address() as AddressInfo).port;
  }

  /** A launcher's request: the path it names is held until the request closes. Anything else is refused. */
  private held(request: IncomingMessage, response: ServerResponse): void {
    const prefix = `/${this.secret}/`;
    const path = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : undefined;
    const release = path === undefined ? undefined : this.hold(path);
    if (release === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200);
    response.flushHeaders();
    request.socket.once('close', release);
  }
}
