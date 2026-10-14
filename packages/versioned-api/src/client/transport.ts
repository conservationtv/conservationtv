import { asError, httpError, type ResponseBody, ResponseBodySchema } from './errors.js';

/** Whatever `new Headers(...)` accepts, named without depending on the DOM lib. */
export type HeaderSource = NonNullable<ConstructorParameters<typeof Headers>[0]>;

/** The options a Client accepts: the base URL and transport controls. Response and error handling are the facade's. */
export interface ClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeaderSource;
}

interface HttpRequest {
  url: string;
  headers?: unknown;
  fetch?: typeof fetch;
}
export interface RawResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}
interface HttpSettings {
  fetch?: typeof fetch;
}
/** What the facade uses of a Hey API fetch client. */
export interface HttpClient {
  get(options: HttpRequest): Promise<RawResult>;
  getConfig(): HttpSettings;
}
interface FixedSettings {
  responseStyle: 'fields';
  throwOnError: false;
  parseAs: 'auto';
}
/** The generated fetch client's module, which each generated Client supplies as its `http` field. */
export interface HttpRuntime {
  createClient(config: ClientConfig & FixedSettings): HttpClient;
  mergeHeaders(...sources: Array<HeaderSource | undefined>): Headers;
}

/** Options retain transport controls; the facade owns response and error handling. */
type ResultOptions<Options> = Omit<NonNullable<Options>, 'throwOnError' | 'responseStyle' | 'parseAs' | 'client'>;
type ResultArguments<Args extends unknown[]> = Args extends [...infer Params, (infer Options)?]
  ? [...Params, options?: ResultOptions<Options>]
  : Args;
interface DataField<Body> {
  data: Body;
}
type SuccessBody<Result> = Result extends DataField<infer Body> ? Exclude<Body, undefined> : never;

/** Error also covers its HTTP and versioning subclasses; instanceof narrows them before the success body. */
export type ResultCall<Method> = Method extends (...args: infer Args) => Promise<infer Result>
  ? (...args: ResultArguments<Args>) => Promise<SuccessBody<Result> | Error>
  : never;

/**
 * A generated BaseClient takes the fetch client its own job generated. The transport supplies that client, but can
 * only name it structurally, so the argument type is left open and the construction site documents the boundary.
 */
export interface SdkClassArgs {
  client: never;
}
export type SdkClass = new (args: SdkClassArgs) => object;
type At<Value, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Value
    ? At<Value[Head], Rest>
    : never
  : Path extends keyof Value
    ? Value[Path]
    : never;
export type SdkMethod<Sdk, Id extends string> = Sdk extends new (args: SdkClassArgs) => infer Instance
  ? At<Instance, Id>
  : never;

export type BoundMethod = (...args: unknown[]) => Promise<RawResult>;
interface SdkNode {
  readonly [segment: string]: SdkNode | BoundMethod;
}
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
  private readonly sdks = new Map<SdkClass, SdkNode>();

  constructor(config?: ClientConfig) {
    this.config = config;
  }

  protected get transport(): HttpClient {
    if (!this.client) {
      this.client = this.http.createClient({
        ...this.config,
        responseStyle: 'fields',
        throwOnError: false,
        parseAs: 'auto'
      });
    }
    return this.client;
  }

  protected operation<const Id extends string, Sdk extends SdkClass>(id: Id, sdk: Sdk): ResultCall<SdkMethod<Sdk, Id>> {
    const call = async (...args: unknown[]) => (await this.send(this.method(sdk, id), args)).result;
    // SAFETY: the raw generated method supplies the same parameters and success body; send normalizes every failure.
    return call as ResultCall<SdkMethod<Sdk, Id>>;
  }

  protected method(sdk: SdkClass, operationId: string): BoundMethod {
    let owner = this.sdks.get(sdk);
    if (!owner) {
      // SAFETY: `transport` is the client `http.createClient` made from the same generated module the BaseClient
      // expects, and generated BaseClients contain the operation tree described by SdkNode.
      owner = new sdk({ client: this.transport as never }) as SdkNode;
      this.sdks.set(sdk, owner);
    }
    const path = operationId.split('.');
    for (const part of path.slice(0, -1)) {
      // SAFETY: operation IDs name a path through the generated tree; every segment before the last is a namespace.
      owner = owner[part] as SdkNode;
    }
    // SAFETY: the last segment of a generated operation ID is always a generated method.
    return (owner[path.at(-1)!] as BoundMethod).bind(owner);
  }

  /** Capture the protocol rejection before unwrapping, so version negotiation can refresh and retry safely. */
  protected async send(method: BoundMethod, args: unknown[], version?: number): Promise<Sent> {
    let mismatched = false;
    try {
      // Hey API 0.99 flat methods take options last. Pad omitted optional parameters before injecting them.
      const padded = Array.from({ length: Math.max(method.length, args.length, 1) }, (_, index) => args[index]);
      // SAFETY: the last positional parameter of every generated method is its optional request options.
      const options = padded.at(-1) as ClientConfig | undefined;
      const base = options?.fetch ?? this.transport.getConfig().fetch ?? globalThis.fetch;
      const headers = this.http.mergeHeaders(options?.headers);
      if (version !== undefined) headers.set('Operation-Version', String(version));
      const watch: typeof fetch = async (input, init) => {
        const response = await base(input, init);
        mismatched ||= response.status === 412 && response.headers.has('Operation-Version');
        return response;
      };
      padded[padded.length - 1] = {
        ...options,
        headers: Object.fromEntries(headers),
        fetch: watch,
        responseStyle: 'fields',
        throwOnError: false,
        parseAs: 'auto'
      };
      return { mismatched, result: outcome(await method(...padded)) };
    } catch (error) {
      return { mismatched, result: asError(error) };
    }
  }
}
