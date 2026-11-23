import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

// A language server client over stdio, for TypeScript's own server (`tsc --lsp --stdio`, TypeScript 7), as an editor
// drives it: the repository is the workspace, each file is opened before it is asked about, and requests run
// concurrently. Only what the calls report asks is typed here. It asks for references rather than the call hierarchy:
// that leaves out JSX, so a component's uses would go unseen.

// Type aliases, not interfaces, so a position can be sent as JSON parameters as it is.
export type Position = {
  line: number;
  character: number;
};

export type Range = {
  start: Position;
  end: Position;
};

export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface Location {
  uri: string;
  range: Range;
}

/** What JSON-RPC carries. */
type Json = string | number | boolean | null | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

/** A request's or notification's parameters. */
type Params = Record<string, Json>;

/** What is sent: a request (with an id), a notification (without), or an answer to the server's own request. */
interface Outgoing {
  id?: number;
  method?: string;
  params?: Params;
  result?: null;
}

interface ResponseError {
  message: string;
}

interface Message {
  id?: number;
  method?: string;
  result?: unknown;
  error?: ResponseError;
}

export interface LanguageServer {
  open(file: string, text: string): void;
  symbols(file: string): Promise<DocumentSymbol[]>;
  /** Every place the symbol at `at` is referred to, but its own declaration. */
  references(file: string, at: Position): Promise<Location[]>;
  close(): void;
}

/** The workspace's TypeScript compiler, as installed for this package. */
function compiler(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

/** Splits the server's output into messages: each a `Content-Length` header, a blank line, then that many bytes. */
function reader(onMessage: (message: Message) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return chunk => {
    // A message may arrive split across chunks, or several in one: whole ones are handed on, the rest is kept.
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      // As many whole messages as have arrived; the rest waits for the next chunk.
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(
        buffer
          .subarray(0, end)
          .toString()
          .match(/Content-Length: (\d+)/i)?.[1]
      );
      if (buffer.length < end + 4 + length) return;
      onMessage(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8')));
      buffer = buffer.subarray(end + 4 + length);
    }
  };
}

export function uri(file: string): string {
  return `file://${file}`;
}

/** Starts the server on the repository at `root` and waits for it to be ready. */
export async function startLanguageServer(root: string): Promise<LanguageServer> {
  const child = spawn(compiler(), ['--lsp', '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (message: Message) => void>();
  let next = 1;
  const send = (message: Outgoing) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  child.stdout.on(
    'data',
    reader(message => {
      // The server's own requests (configuration, progress) are answered with nothing; responses go to their caller.
      if (message.id !== undefined && message.method) send({ id: message.id, result: null });
      else if (message.id !== undefined) waiting.get(message.id)?.(message);
    })
  );
  const request = <T>(method: string, params: Params) =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      waiting.set(id, message => {
        waiting.delete(id);
        if (message.error) {
          reject(new Error(`${method}: ${message.error.message}`));
          return;
        }
        // SAFETY: the protocol defines each method's result; the callers below name it.
        resolve(message.result as T);
      });
      send({ id, method, params });
    });
  const notify = (method: string, params: Params) => send({ method, params });

  await request('initialize', {
    processId: process.pid,
    rootUri: uri(root),
    workspaceFolders: [{ uri: uri(root), name: path.basename(root) }],
    capabilities: { textDocument: { references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } }
  });
  notify('initialized', {});

  return {
    open(file, text) {
      notify('textDocument/didOpen', { textDocument: { uri: uri(file), languageId: 'typescript', version: 1, text } });
    },
    async symbols(file) {
      return (
        (await request<DocumentSymbol[] | null>('textDocument/documentSymbol', { textDocument: { uri: uri(file) } })) ??
        []
      );
    },
    async references(file, at) {
      const params = { textDocument: { uri: uri(file) }, position: at, context: { includeDeclaration: false } };
      return (await request<Location[] | null>('textDocument/references', params)) ?? [];
    },
    close() {
      child.kill();
    }
  };
}
