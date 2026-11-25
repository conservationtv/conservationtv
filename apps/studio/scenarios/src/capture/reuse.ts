import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';

import type { ReportData, ReportShot } from './report.ts';
import { readReport } from './reports.ts';

// Shots taken again only when they could have changed. A shot draws the same page whenever the browser runs the same
// code against the same answers: the mock API, the worlds and the capture are the run's own on both sides (a report
// records them as `capturedWith`, a fingerprint the caller gives), and the code is the web app's files the page loaded
// (each shot's `loaded`). So an earlier report's shot is taken as this run's own when the two runs were captured with
// the same fingerprint and every file the page loaded is the same, to the byte, in both builds. Each report records its
// build's files by content (`build`) for later runs to check against.

/** A build's files by their path in it, each with its MD5. */
export type BuildFiles = Record<string, string>;

/**
 * React Router's manifest: renamed by every build in which any route's code changed, and named by both HTML pages. A
 * page's own routes' code is among the files it loaded, so the manifest counts only for its routes (which there
 * are, and where), under one name; the HTML pages count without its name.
 */
const MANIFEST = /assets\/manifest-[\w-]+\.js/gu;
const MANIFEST_FILE = 'assets/manifest.js';

function md5(content: string | Buffer): string {
  return createHash('md5').update(content).digest('hex');
}

/** A route as the manifest lists it, without the files its code is in (which zod leaves out). */
const ManifestRouteSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  path: z.string().optional(),
  index: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  hasAction: z.boolean().optional(),
  hasLoader: z.boolean().optional(),
  hasClientAction: z.boolean().optional(),
  hasClientLoader: z.boolean().optional(),
  hasClientMiddleware: z.boolean().optional(),
  hasDefaultExport: z.boolean().optional(),
  hasErrorBoundary: z.boolean().optional()
});
type ManifestRoute = z.output<typeof ManifestRouteSchema>;
const ManifestSchema = z.object({ routes: z.record(z.string(), ManifestRouteSchema) });
type Manifest = z.output<typeof ManifestSchema>;

/** The manifest's routes without the files they're in: where a page could be routed, not what code it runs. */
function manifestRoutes(script: string): string {
  const manifest: Manifest = ManifestSchema.parse(
    JSON.parse(script.slice(script.indexOf('=') + 1).replace(/;\s*$/u, ''))
  );
  const routes: Record<string, ManifestRoute> = manifest.routes;
  return JSON.stringify(routes);
}

/** A build's file as it counts: the manifest by its routes, an HTML page without the manifest's name, else its bytes. */
function contentOf(file: string, bytes: Buffer): [string, string] {
  if (/^assets\/manifest-[\w-]+\.js$/u.test(file)) return [MANIFEST_FILE, md5(manifestRoutes(bytes.toString('utf8')))];
  if (file.endsWith('.html')) return [file, md5(bytes.toString('utf8').replace(MANIFEST, MANIFEST_FILE))];
  return [file, md5(bytes)];
}

/** Every file of a built web app, by its path relative to the build, with its MD5 as it counts (contentOf). */
export function buildFilesOf(web: string): BuildFiles {
  const entries: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries.push(contentOf(relative(web, path), readFileSync(path)));
    }
  };
  walk(web);
  return Object.fromEntries(entries);
}

/** The mock's own script: the run's on both sides, so never a difference between builds. */
const FROM_THE_MOCK = new Set(['/config.js']);

/**
 * The content a path was answered with, as the scenario server serves it (src/serve.ts): a file of the build, a
 * directory's index.html, or else the SPA fallback. Null for what the mock answers itself.
 */
function servedContent(build: BuildFiles, path: string): string | null {
  if (FROM_THE_MOCK.has(path)) return null;
  const file = (path.endsWith('/') ? `${path}index.html` : path).slice(1).replace(MANIFEST, MANIFEST_FILE);
  return build[file] ?? build['__spa-fallback.html'] ?? 'missing';
}

/**
 * An earlier report shots can be taken from: a directory, or the address of one the review tool serves (a run's files,
 * `…/api/results/<commit>/scenarios`), whose files are fetched as they're taken. `at` is where it is, either way.
 */
export interface ReuseSource {
  at: string;
  data: ReportData;
}

function isRemote(at: string): boolean {
  return /^https?:\/\//u.test(at);
}

/** An earlier report to reuse, or null (said why) when there is none there: a remote one not uploaded, say. */
export async function reuseSourceOf(at: string): Promise<ReuseSource | null> {
  if (!isRemote(at)) return existsSync(join(at, 'report.json')) ? { at, data: readReport(at) } : null;
  const response = await fetch(`${at}/report.json`).catch(() => null);
  if (!response?.ok) {
    console.log(`No report to reuse at ${at}${response ? ` (${response.status})` : ''}.`);
    return null;
  }
  const data: ReportData = await response.json();
  return { at, data };
}

/** A shot to take from an earlier report rather than capture. */
export interface Reused {
  source: ReuseSource;
  shot: ReportShot;
}

/** The earlier reports' shots this run can take as its own, found by key. */
export class Reuse {
  private readonly shots = new Map<string, Reused>();

  constructor(sources: ReuseSource[], capturedWith: string | null, build: BuildFiles) {
    // Nothing is reused unless this run says what it captures with; then, from the first source that has it, each
    // shot of a source captured the same way, whose page loaded only files this build has the same.
    if (!capturedWith) return;
    for (const source of sources) this.add(source, capturedWith, build);
  }

  private add(source: ReuseSource, capturedWith: string, build: BuildFiles) {
    // A source from before reports recorded their build, or captured another way, offers nothing.
    const { build: theirs, capturedWith: theirFingerprint } = source.data;
    if (!theirs || theirFingerprint !== capturedWith) return;
    for (const shot of source.data.shots) {
      // The first source to offer a shot keeps it.
      if (!this.shots.has(shot.key) && sameCode(shot, theirs, build)) this.shots.set(shot.key, { source, shot });
    }
  }

  get(key: string): Reused | undefined {
    return this.shots.get(key);
  }

  get size(): number {
    return this.shots.size;
  }
}

/** Whether every file a shot's page loaded is the same in this build as in the one it was taken from. */
function sameCode(shot: ReportShot, theirs: BuildFiles, ours: BuildFiles): boolean {
  if (!shot.loaded?.length) return false;
  return shot.loaded.every(path => servedContent(theirs, path) === servedContent(ours, path));
}

/** A file of a source put at a path of this report: copied, or fetched. False when the source hasn't got it. */
async function fetchFile(at: string, file: string, to: string): Promise<boolean> {
  mkdirSync(dirname(to), { recursive: true });
  if (!isRemote(at)) {
    if (!existsSync(join(at, file))) return false;
    copyFileSync(join(at, file), to);
    return true;
  }
  const response = await fetch(`${at}/${file}`).catch(() => null);
  if (!response?.ok) return false;
  writeFileSync(to, Buffer.from(await response.arrayBuffer()));
  return true;
}

/**
 * A reused shot's files put into this report at the same paths. False when its image can't be had (a remote file gone
 * missing), so the shot is captured after all; a missing thumbnail or snapshot only goes without.
 */
export async function copyReused({ source, shot }: Reused, outDir: string): Promise<boolean> {
  const [image] = await Promise.all(
    [shot.file, shot.thumb, shot.aria].map(file => (file ? fetchFile(source.at, file, join(outDir, file)) : false))
  );
  return image === true;
}
