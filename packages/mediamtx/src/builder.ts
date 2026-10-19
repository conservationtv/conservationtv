import { MediamtxConfigSchema } from './generated/zod.gen.js';
import type { MediamtxConfig, PathConf } from './generated/types.gen.js';

// Config builders: a MediaMTX config assembled by steps, each a handler that reads its params and writes into one
// shared config. `pipe` and `pipeline` chain them, and the chain's params are what every step needs. Rendering runs the
// steps in order, then checks the result against the schema.
//
// A step reports what it can't do through its context rather than by throwing: a warning or an error, collected with
// the schema's issues. Any error makes the rendered config unfit to serve; warnings alone don't. A step that throws is
// a bug, and fails the render.

/** What a diagnostic is about, such as `{ kind: 'path', id: 'cam1' }`. */
export interface DiagnosticTarget {
  kind: string;
  id: string;
}

/** Plain values only, so a diagnostic can be stored and sent as it is. */
export type DiagnosticDetail = string | number | boolean | null;

/** Something a render could not do as asked, and what it was about. */
export interface BuildDiagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  target?: DiagnosticTarget;
  /** Whether rendering again may succeed as it is, or something must change first. */
  recovery?: 'retryable' | 'change-required';
  details?: Record<string, DiagnosticDetail>;
}

/** A rendered config and everything its steps and the schema said about it. */
export interface RenderResult<TConfig> {
  config: TConfig;
  diagnostics: BuildDiagnostic[];
}

export type DiagnosticInput = Omit<BuildDiagnostic, 'severity'>;

/** What a step can report through, besides the config it writes. */
export interface BuildContext {
  warning(diagnostic: DiagnosticInput): void;
  /** Collects; doesn't throw, so the remaining steps still run and report. */
  error(diagnostic: DiagnosticInput): void;
}

/** The config as steps write it: `paths` is always there, so a step can set `config.paths[id]`. */
export interface MediamtxConfigDraft extends MediamtxConfig {
  paths: Record<string, PathConf>;
}

export type Handler<P> = (params: P, config: MediamtxConfigDraft, ctx: BuildContext) => void | Promise<void>;

export class MediamtxConfigBuilder<P> {
  constructor(private readonly handler: Handler<P>) {}

  /** This step, then `next`, with the params both need. */
  pipe<Q>(next: MediamtxConfigBuilder<Q>): MediamtxConfigBuilder<P & Q> {
    return new MediamtxConfigBuilder<P & Q>(async (params, config, ctx) => {
      await this.handler(params, config, ctx);
      await next.handler(params, config, ctx);
    });
  }

  /** Runs every step on an empty config, then checks it against the schema. */
  async render(params: P): Promise<RenderResult<MediamtxConfig>> {
    const diagnostics: BuildDiagnostic[] = [];
    const ctx: BuildContext = {
      warning: diagnostic => diagnostics.push({ ...diagnostic, severity: 'warning' }),
      error: diagnostic => diagnostics.push({ ...diagnostic, severity: 'error' })
    };
    const config: MediamtxConfigDraft = { paths: {} };
    await this.handler(params, config, ctx);

    const result = MediamtxConfigSchema.safeParse(config);
    if (result.success) return { config: result.data, diagnostics };
    for (const issue of result.error.issues) {
      const diagnostic: BuildDiagnostic = {
        severity: 'error',
        code: 'invalid-config',
        message: issue.message,
        recovery: 'change-required',
        details: { path: issue.path.join('.') }
      };
      const [section, id] = issue.path;
      if (section === 'paths' && id !== undefined) diagnostic.target = { kind: 'path', id: String(id) };
      diagnostics.push(diagnostic);
    }
    return { config, diagnostics };
  }
}

type ParamsOf<B> = B extends MediamtxConfigBuilder<infer P> ? P : never;

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;

/** The steps in order, as one builder whose params are what every step needs. */
export function pipeline<Builders extends readonly MediamtxConfigBuilder<any>[]>(
  ...builders: Builders
): MediamtxConfigBuilder<UnionToIntersection<ParamsOf<Builders[number]>>> {
  const empty = new MediamtxConfigBuilder<unknown>(() => {});
  // SAFETY: each `pipe` intersects the next step's params, so the chain needs exactly the intersection of them all.
  return builders.reduce((chain, next) => chain.pipe(next), empty) as MediamtxConfigBuilder<
    UnionToIntersection<ParamsOf<Builders[number]>>
  >;
}
