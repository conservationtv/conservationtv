import * as z from 'zod';
import { asError, httpError, type ResponseBody, ResponseBodySchema } from './errors.js';

/** Whatever `new Headers(...)` accepts, named without depending on the DOM lib. */
export type HeaderSource = NonNullable<ConstructorParameters<typeof Headers>[0]>;

/**
 * How a Client authenticates: given each request as it is about to be sent, with every header and its body, return it
 * with credentials added. `bearer` sends a token; an API's SDK may offer others, such as signing.
 */
export type Authenticate = (request: Request) => Request | Promise<Request>;

/** Send `token` as `Authorization: Bearer …`. */
export function bearer(token: string): Authenticate {
  return request => {
    request.headers.set('authorization', `Bearer ${token}`);
    return request;
  };
}

/** The options a Client accepts: the base URL and transport controls. Response and error handling are the facade's. */
export interface ClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeaderSource;
  auth?: Authenticate;
}

/** What one call may override of its Client's configuration, and the signal that aborts it. */
export interface CallOptions extends Omit<ClientConfig, 'auth'> {
  signal?: AbortSignal;
}

type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD' | 'TRACE';

/** A member of a call's parameters sent in one part of the request, under `map` when its name there differs. */
interface PlacedField {
  in: 'headers' | 'path' | 'query' | 'body';
  key: string;
  map?: string;
}
/** A member of a call's parameters that is the request's whole body. */
interface BodyField {
  key: string;
  map: 'body';
}
/** Where one member of a call's flat parameters goes in the request, as Hey API's `buildClientParams` reads it. */
export type OperationField = PlacedField | BodyField;

/** One operation as a contract defines it: all the generated Client holds of it at runtime. */
export interface OperationDescriptor {
  method: HttpMethod;
  /** The path template, such as `/organisations/{id}`. */
  url: string;
  /** Absent when a call takes no parameters, only its options. */
  fields?: readonly OperationField[];
}

declare const signature: unique symbol;
interface Signature<Output, Input> {
  output: Output;
  input: Input;
}
/**
 * A descriptor that also carries, in its type alone, what a call takes and what it answers. `Input` is `never` for an
 * operation without parameters.
 */
export interface Operation<Output = unknown, Input = unknown> extends OperationDescriptor {
  readonly [signature]?: Signature<Output, Input>;
}

/** Gives a descriptor the types of the contract it was generated from. */
export function operation<Output, Input = never>(descriptor: OperationDescriptor): Operation<Output, Input> {
  return descriptor;
}

// The members of one part of a request, by the names the request has for them. Their values are a caller's, typed by
// the contract's Input and serialised by the fetch client.
const MembersSchema = z.record(z.string(), z.unknown());
type Members = z.output<typeof MembersSchema>;

/** A request's parts, as `buildClientParams` sorts a call's parameters into them. Empty parts are left out. */
interface RequestParts {
  body?: unknown;
  headers?: Members;
  path?: Members;
  query?: Members;
}
interface FieldGroup {
  args: readonly OperationField[];
}
/** The address of a request: the URL template, with the path and query parameters to fill it with. */
interface UrlRequest {
  url: string;
  path?: Members;
  query?: Members;
}
interface HttpRequest extends UrlRequest, FixedSettings {
  method: HttpMethod;
  body?: unknown;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}
interface PublishedRequest {
  url: string;
  headers?: unknown;
}
export interface RawResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}
interface HttpSettings {
  fetch?: typeof fetch;
}
interface RequestInterceptors {
  use(interceptor: Authenticate): number;
}
interface HttpInterceptors {
  request: RequestInterceptors;
}
/** What the facade uses of a Hey API fetch client. */
export interface HttpClient {
  get(options: PublishedRequest): Promise<RawResult>;
  request(options: HttpRequest): Promise<RawResult>;
  buildUrl(options: UrlRequest): string;
  getConfig(): HttpSettings;
  interceptors: HttpInterceptors;
}
interface FixedSettings {
  responseStyle: 'fields';
  throwOnError: false;
  parseAs: 'auto';
}
/** The generated fetch client's module, which each generated Client supplies as its `http` field. */
export interface HttpRuntime {
  createClient(config: Omit<ClientConfig, 'auth'> & FixedSettings): HttpClient;
  mergeHeaders(...sources: Array<HeaderSource | Members | undefined>): Headers;
  buildClientParams(args: readonly unknown[], fields: readonly FieldGroup[]): RequestParts;
}

type Optional<Input> = Record<never, never> extends Input ? true : false;
type InputArguments<Input> = [Input] extends [never]
  ? []
  : Optional<Input> extends true
    ? [parameters?: Input]
    : [parameters: Input];

/** Error also covers its HTTP and versioning subclasses; instanceof narrows them before the success body. */
export type OperationCall<Described> =
  Described extends Operation<infer Output, infer Input>
    ? (...args: [...InputArguments<Input>, options?: CallOptions]) => Promise<Exclude<Output, undefined> | Error>
    : never;

/** A WebSocket operation's address: its parameters, without options, to a `ws:` or `wss:` URL. */
export type WebSocketAddress<Described> =
  Described extends Operation<unknown, infer Input> ? (...args: InputArguments<Input>) => string : never;

/** A parsed success body (or `undefined` for 204), or the Error the call failed with. */
export type OperationOutcome = ResponseBody | Error;

export interface Sent {
  mismatched: boolean;
  result: OperationOutcome;
}

/** Unwrap Hey API's `fields` result: HTTP failures become HttpErrors, transport failures stay Errors. */
function outcome(raw: RawResult): OperationOutcome {
  if (!raw.response) return asError(raw.error);
  if (!raw.response.ok) return httpError(raw.response, ResponseBodySchema.safeParse(raw.error).data);
  if (raw.error !== undefined) return asError(raw.error);
  if (raw.response.status === 204) return undefined;
  const body = ResponseBodySchema.safeParse(raw.data);
  return body.success ? body.data : asError(body.error);
}

/**
 * Transport and result handling behind a generated Client. The generated class supplies its own fetch client as
 * `http`; the transport is created on first use, after the subclass's fields have initialised.
 */
export abstract class ClientTransport {
  protected abstract readonly http: HttpRuntime;
  private readonly config: ClientConfig | undefined;
  private client: HttpClient | undefined;

  constructor(config?: ClientConfig) {
    this.config = config;
  }

  protected get transport(): HttpClient {
    if (!this.client) {
      // Hey API's own `auth` resolves security-scheme tokens, so ours runs as a request interceptor instead: after the
      // request is complete, and for the handshake too.
      const { auth, ...config } = this.config ?? {};
      this.client = this.http.createClient({
        ...config,
        responseStyle: 'fields',
        throwOnError: false,
        parseAs: 'auto'
      });
      if (auth !== undefined) this.client.interceptors.request.use(auth);
    }
    return this.client;
  }

  /** An operation as a call: its parameters, then options, to its success body or the Error it failed with. */
  protected call<Described extends Operation>(described: Described): OperationCall<Described> {
    const call = async (...args: unknown[]) => (await this.send(described, args)).result;
    // SAFETY: the descriptor's types are those of the contract its method, URL and fields were generated from, and
    // send normalizes every failure.
    return call as OperationCall<Described>;
  }

  /** A WebSocket operation's address: its URL, filled from the base URL and the path and query parameters. */
  protected webSocket<Described extends Operation>(described: Described): WebSocketAddress<Described> {
    const address = (...args: unknown[]) => {
      const parts = this.http.buildClientParams([args[0]], [{ args: described.fields ?? [] }]);
      const built = this.transport.buildUrl({ url: described.url, path: parts.path, query: parts.query });
      const url = new URL(built);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.href;
    };
    // SAFETY: the descriptor's Input is the type of the parameters its fields were generated for.
    return address as WebSocketAddress<Described>;
  }

  /**
   * One request's headers: JSON's content type when its descriptor has body fields, as Hey API's generated methods say
   * it themselves; then the call's own, its header parameters, and the version it asks for.
   */
  private headers(
    fields: readonly OperationField[],
    sources: Array<HeaderSource | Members | undefined>,
    version?: number
  ) {
    const sendsBody = fields.some(field => ('in' in field ? field.in : field.map) === 'body');
    const headers = this.http.mergeHeaders(sendsBody ? { 'Content-Type': 'application/json' } : undefined, ...sources);
    if (version !== undefined) headers.set('Operation-Version', String(version));
    return Object.fromEntries(headers);
  }

  /** Capture the protocol rejection before unwrapping, so version negotiation can refresh and retry safely. */
  protected async send(described: OperationDescriptor, args: unknown[], version?: number): Promise<Sent> {
    let mismatched = false;
    try {
      const fields = described.fields ?? [];
      // A call takes its parameters first only when its contract has any; its options are always last.
      const [parameters, given] = fields.length ? args : [undefined, args[0]];
      // SAFETY: the last positional parameter of every call is its optional request options.
      const options = given as CallOptions | undefined;
      const parts = this.http.buildClientParams([parameters], [{ args: fields }]);
      const base = options?.fetch ?? this.transport.getConfig().fetch ?? globalThis.fetch;
      const watch: typeof fetch = async (input, init) => {
        const response = await base(input, init);
        mismatched ||= response.status === 412 && response.headers.has('Operation-Version');
        return response;
      };
      const raw = await this.transport.request({
        ...options,
        ...parts,
        method: described.method,
        url: described.url,
        headers: this.headers(fields, [options?.headers, parts.headers], version),
        fetch: watch,
        responseStyle: 'fields',
        throwOnError: false,
        parseAs: 'auto'
      });
      return { mismatched, result: outcome(raw) };
    } catch (error) {
      return { mismatched, result: asError(error) };
    }
  }
}
