import { createClient, mergeHeaders, type Client as HttpClient, type Config } from './generated/client/index.js';
import { asError, httpError, type ResponseBody, ResponseBodySchema } from './errors.js';

export type ClientConfig = Omit<Config, 'throwOnError' | 'responseStyle' | 'parseAs'>;

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

export interface SdkClassArgs {
  client: HttpClient;
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

interface RawResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}
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

/** Transport and result handling behind the generated Client. */
export class ClientTransport {
  protected readonly http: HttpClient;
  private readonly sdks = new Map<SdkClass, SdkNode>();

  constructor(config?: ClientConfig) {
    this.http = createClient({ ...config, responseStyle: 'fields', throwOnError: false, parseAs: 'auto' });
  }

  protected operation<const Id extends string, Sdk extends SdkClass>(id: Id, sdk: Sdk): ResultCall<SdkMethod<Sdk, Id>> {
    const method = this.method(sdk, id);
    const call = async (...args: unknown[]) => (await this.send(method, args)).result;
    // SAFETY: the raw generated method supplies the same parameters and success body; send normalizes every failure.
    return call as ResultCall<SdkMethod<Sdk, Id>>;
  }

  protected method(sdk: SdkClass, operationId: string): BoundMethod {
    let owner = this.sdks.get(sdk);
    if (!owner) {
      // SAFETY: generated BaseClients contain the generated operation tree described by SdkNode.
      owner = new sdk({ client: this.http }) as SdkNode;
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
      const options = padded.at(-1) as Config | undefined;
      const base = options?.fetch ?? this.http.getConfig().fetch ?? globalThis.fetch;
      const headers = mergeHeaders(options?.headers);
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
