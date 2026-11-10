import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { definePluginConfig, type DefinePlugin, type Plugin } from '@hey-api/openapi-ts';
import { z } from 'zod';
import { flatFields, operationParams, type FlatField } from './operation-params.js';

interface RustManifestUserOptions {
  name: 'rust-manifest';
  /** Where to write this job's manifest. */
  file: string;
  /** The generation source this job is for: `current`, or a frozen contract's `<operationId>-vN`. */
  source: string;
}
interface RustManifestOptions {
  name: 'rust-manifest';
  file: string;
  source: string;
}
type UserConfig = RustManifestUserOptions & Plugin.Hooks & Plugin.UserExports;
type Config = RustManifestOptions & Plugin.Hooks & Plugin.Exports;
type RustManifestPlugin = DefinePlugin<UserConfig, Config>;

const OperationVersionSchema = z.int().positive();
type OperationVersion = z.output<typeof OperationVersionSchema>;

/** One operation as the Rust generator renders it: its route, and the flat Params every SDK generator shares. */
export interface ManifestOperation {
  operationId: string;
  version?: OperationVersion;
  method: string;
  path: string;
  /** The Params name base, like `GrantExchange`, before any version suffix. */
  base: string;
  description: string;
  fields: FlatField[];
}

/** A job's operations and the document they were read from, which the Rust generator takes its schemas from. */
export interface Manifest {
  source: string;
  operations: ManifestOperation[];
  document: unknown;
}

/**
 * Writes what the Rust SDK generator (`packages/versioned-api/rust/codegen`) needs of one generation job. The names
 * and flat fields come from the same `operationParams`/`flatFields` the TypeScript SDK and CLI use, so the SDKs
 * cannot drift apart on them; the Rust side only renders. Tested with Hey API 0.99.0.
 */
export const rustManifest = definePluginConfig<RustManifestPlugin['Types']>({
  name: 'rust-manifest',
  config: { file: '', source: '' },
  handler({ plugin }) {
    const { file, source } = plugin.config;
    if (!file || !source) throw new Error('rust-manifest requires file and source');
    const operations: ManifestOperation[] = [];
    plugin.forEach('operation', ({ operation }) => {
      const id = operation.operationId;
      if (!id) throw new Error(`Missing operationId: ${operation.id}`);
      const { base, fields } = operationParams(operation);
      const description = [...new Set([operation.summary, operation.description].filter(Boolean))].join('\n\n');
      operations.push({
        operationId: id,
        version: OperationVersionSchema.safeParse(operation['x-operation-version']).data,
        method: operation.method,
        path: operation.path,
        base,
        description,
        fields: flatFields(operation, fields)
      });
    });
    const manifest: Manifest = { source, operations, document: plugin.context.spec };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
});
