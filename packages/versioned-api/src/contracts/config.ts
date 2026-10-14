import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Hono } from 'hono';
import type { GenerateSpecOptions } from 'hono-openapi';
import { z } from 'zod';
import type { OperationRouter } from '../server/operation-router.js';

/** Response schemas, keyed by export name; the Zod ones with `meta({ id })` name their types in the document. */
export type ResponseSchemas = Readonly<Record<string, StandardSchemaV1>>;

/** The Worker source directory, and the app and schemas modules inside it (module specifiers relative to `dir`). */
export interface SourceConfig {
  dir?: string;
  app?: string;
  schemas?: string;
}

/** What an API's `contracts.config.ts` exports. Paths are relative to that file. */
export interface ContractsConfig {
  /** The complete Hono app, built with `router` so each operation's versions are known. */
  app: Hono;
  router: OperationRouter;
  spec: Partial<GenerateSpecOptions>;
  schemas: ResponseSchemas;
  /** The release tag prefix: snapshots are `<release>-vX.Y.Z`. */
  release: string;
  /** The published bundle. Default `./contracts/openapi.json`: a directory, so a Vite dev server never serves it as a file. */
  document?: string;
  /** Frozen release bundles. Default `./contracts/snapshots`. */
  snapshots?: string;
  /** The Worker's TypeScript project, whose types describe the handlers' responses. Default `./tsconfig.json`. */
  tsconfig?: string;
  source?: SourceConfig;
}

export function defineContracts(config: ContractsConfig): ContractsConfig {
  return config;
}

export interface SourceLayout {
  /** Absolute, with a trailing slash. */
  dir: string;
  app: string;
  schemas: string;
}

/** `document` and `snapshots` as Git paths, relative to the repository root. */
export interface GitPaths {
  document: string;
  snapshots: string;
}

/** A config resolved to absolute paths, plus the repository the API lives in. */
export interface ContractsProject {
  app: Hono;
  router: OperationRouter;
  spec: Partial<GenerateSpecOptions>;
  schemas: ResponseSchemas;
  release: string;
  dir: string;
  document: string;
  snapshots: string;
  tsconfig: string;
  source: SourceLayout;
  /** The Git work tree root; snapshot immutability and PR comparisons read history relative to it. */
  root: string;
  paths: GitPaths;
}

// The config module is the API's own code, so only its shape as a module is checked here; each field is used as typed.
const ModuleSchema = z.object({ default: z.custom<ContractsConfig>() });
type Module = z.output<typeof ModuleSchema>;

interface ResolvedPaths {
  dir: string;
  document: string;
  snapshots: string;
  tsconfig: string;
  source: SourceLayout;
  root: string;
  paths: GitPaths;
}

/** Apply the defaults and make every path absolute; Git paths come from the work tree the config lives in. */
function resolvePaths(configPath: string, config: ContractsConfig): ResolvedPaths {
  const dir = dirname(configPath);
  const at = (path: string) => resolve(dir, path);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
  const document = at(config.document ?? 'contracts/openapi.json');
  const snapshots = at(config.snapshots ?? 'contracts/snapshots');
  const source = config.source ?? {};
  return {
    dir,
    document,
    snapshots,
    tsconfig: at(config.tsconfig ?? 'tsconfig.json'),
    source: { dir: `${at(source.dir ?? 'src')}/`, app: source.app ?? './app', schemas: source.schemas ?? './schemas' },
    root,
    paths: { document: toGitPath(root, document), snapshots: `${toGitPath(root, snapshots)}/` }
  };
}

export async function loadProject(configPath = resolve('contracts.config.ts')): Promise<ContractsProject> {
  const loaded: Module = ModuleSchema.parse(await import(pathToFileURL(configPath).href));
  const { app, router, spec, schemas, release } = loaded.default;
  return { app, router, spec, schemas, release, ...resolvePaths(configPath, loaded.default) };
}

function toGitPath(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}

/** `releaseName('gatekeeper', 'gatekeeper-v1.0.0')`: validate a tag of this project. */
export function releaseName(project: Pick<ContractsProject, 'release'>, name: string | undefined): string {
  const pattern = new RegExp(`^${escape(project.release)}-v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$`);
  if (!name || !pattern.test(name)) {
    throw new Error(`Provide a release tag, for example ${project.release}-v1.0.0`);
  }
  return name;
}

/** Compare release tags numerically, independently of file timestamps or lexical order. */
export function compareReleases(project: Pick<ContractsProject, 'release'>, a: string, b: string): number {
  const prefix = `${project.release}-v`.length;
  const left = a.slice(prefix).split('.').map(BigInt);
  const right = b.slice(prefix).split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function fileUrl(path: string): URL {
  return pathToFileURL(path);
}

export function filePath(url: URL): string {
  return fileURLToPath(url);
}
