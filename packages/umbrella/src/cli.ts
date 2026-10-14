#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { glob, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { migrationHeader, rlsMigration, rlsTeardownMigration } from './rls.js';

const usage = `Usage: umbrella generate [--config drizzle.config.ts] [--name access_policies] [--before]

Writes a Drizzle Kit custom migration containing the access policies for the schema in your Drizzle config,
when they differ from the latest one generated. Run it after \`drizzle-kit generate\`.

  --config  Drizzle Kit config file. Defaults to drizzle.config.{ts,mts,js,mjs} in the current directory.
  --name    Migration name. Defaults to access_policies, or drop_access_policies with --before.
  --before  Write a migration that drops the access policies instead. Generate it before a
            \`drizzle-kit generate\` that changes the type of, or drops, a scope key or link column.`;

const defaultConfigs = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.js', 'drizzle.config.mjs'];
const sourceFiles = '**/*.{ts,mts,cts,js,mjs,cjs}';
const DrizzleConfigSchema = z.object({
  schema: z.union([z.string().transform(path => [path]), z.array(z.string()).nonempty()]),
  out: z.string().default('drizzle')
});
type DrizzleConfig = z.output<typeof DrizzleConfigSchema>;
const ModuleSchema = z.record(z.string(), z.unknown());
type Module = z.output<typeof ModuleSchema>;
const PackageSchema = z.object({
  bin: z.union([z.string(), z.record(z.string(), z.string()).transform(bins => bins['drizzle-kit'])])
});
type Package = z.output<typeof PackageSchema>;

class UsageError extends Error {}

/**
 * Loads TypeScript through tsx when the project has it, otherwise through Node's own type stripping. tsx is
 * registered globally rather than namespaced, so the schema shares this package's module instance and with it
 * the registry of access definitions.
 */
async function enableTypeScript(): Promise<void> {
  const tsx = await import('tsx/esm/api').catch(() => undefined);
  tsx?.register();
}

async function importModule(file: string): Promise<Module> {
  return ModuleSchema.parse(await import(pathToFileURL(file).href));
}

function configPath(option: string | undefined): string {
  const candidates = option === undefined ? defaultConfigs : [option];
  const found = candidates.map(file => resolve(file)).find(file => existsSync(file));
  if (!found) throw new UsageError(`Drizzle config not found: ${candidates.join(', ')}`);
  return found;
}

async function loadConfig(file: string): Promise<DrizzleConfig> {
  const loaded = await importModule(file);
  return DrizzleConfigSchema.parse(loaded['default'] ?? loaded);
}

/** Drizzle Kit resolves schema paths from the working directory and accepts files, folders and globs. */
async function schemaFiles(patterns: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const folder = await stat(pattern).catch(() => undefined);
    const expanded = folder?.isDirectory() ? join(pattern, sourceFiles) : pattern;
    for await (const file of glob(expanded)) files.add(resolve(file));
  }
  if (!files.size) throw new UsageError(`No schema files match ${patterns.join(', ')}`);
  return [...files].sort();
}

// Schema modules commonly re-export each other's tables; each table is registered once, under its first export.
async function loadTables(files: readonly string[]): Promise<Record<string, PgTable>> {
  const tables = new Map<PgTable, string>();
  for (const file of files) {
    const exported = await importModule(file);
    for (const [name, value] of Object.entries(exported))
      if (is(value, PgTable) && !tables.has(value)) tables.set(value, `${relative('.', file)}#${name}`);
  }
  return Object.fromEntries([...tables].map(([table, name]) => [name, table]));
}

async function sqlFiles(out: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob('**/*.sql', { cwd: out })) files.push(file);
  // Drizzle Kit prefixes migrations with an index or timestamp, so path order is migration order.
  return files.sort();
}

async function latestGenerated(out: string): Promise<string | undefined> {
  const files = await sqlFiles(out);
  for (const file of files.reverse()) {
    const content = await readFile(join(out, file), 'utf8');
    if (content.startsWith(migrationHeader)) return content;
  }
  return undefined;
}

/**
 * Finds the project's Drizzle Kit by walking up from the working directory, as Node module resolution does,
 * and stops with an error at the filesystem root.
 */
async function drizzleKitBin(): Promise<string> {
  for (let folder = resolve('.'); ; folder = dirname(folder)) {
    const root = join(folder, 'node_modules', 'drizzle-kit');
    const manifest = await readFile(join(root, 'package.json'), 'utf8').catch(() => undefined);
    if (manifest !== undefined) {
      const { bin }: Package = PackageSchema.parse(JSON.parse(manifest));
      if (bin) return join(root, bin);
    }
    if (dirname(folder) === folder) throw new UsageError('drizzle-kit is not installed in this project');
  }
}

/** Lets Drizzle Kit create the file and its journal entry, then fills in the one new SQL file it wrote. */
async function writeCustomMigration(config: string, out: string, name: string, content: string): Promise<string> {
  const before = new Set(await sqlFiles(out).catch(() => []));
  const args = ['generate', '--custom', `--name=${name}`, `--config=${config}`];
  const result = spawnSync(process.execPath, [await drizzleKitBin(), ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new UsageError('drizzle-kit generate --custom failed');
  const created = (await sqlFiles(out)).filter(file => !before.has(file));
  if (created.length !== 1) throw new UsageError(`Expected one new migration in ${out}, found ${created.length}`);
  const file = join(out, created[0]!);
  await writeFile(file, content);
  return file;
}

// The teardown needs no schema; an unchanged result writes nothing, so repeated runs are safe.
async function generate(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: { config: { type: 'string' }, name: { type: 'string' }, before: { type: 'boolean', default: false } }
  });
  const config = configPath(values.config);
  await enableTypeScript();
  const { schema, out } = await loadConfig(config);
  const content = values.before ? rlsTeardownMigration() : rlsMigration(await loadTables(await schemaFiles(schema)));
  if ((await latestGenerated(out)) === content) {
    console.log('Access policies are already up to date.');
    return;
  }
  const name = values.name ?? (values.before ? 'drop_access_policies' : 'access_policies');
  console.log(`Wrote ${relative('.', await writeCustomMigration(config, out, name, content))}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command !== 'generate') throw new UsageError(usage);
  await generate(rest);
} catch (error) {
  console.error(error instanceof UsageError ? error.message : error);
  process.exitCode = 1;
}
