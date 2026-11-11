import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, type UserConfig } from '@hey-api/openapi-ts';
import { CURRENT, readOperations, rustManifest } from '@conservationtv/versioned-api/codegen';
import { minimumVersions } from '@conservationtv/studio-sdk/minimum-versions';

// Writes .generate: the manifests the Swift generator (packages/versioned-api/swift/codegen) renders Generated/ from.
// The jobs mirror the TypeScript SDK's (../ts/openapi-ts.config.ts), with the same oldest versions kept: one for the
// current spec's versionless operations, and one per frozen operation contract. `pnpm generate` runs both steps.
const spec = createRequire(import.meta.url).resolve('@conservationtv/studio-api/openapi.json');

const operations = readOperations(spec, { minimumVersions });
const snapshots = Map.groupBy(
  operations.versioned.filter(operation => operation.source !== CURRENT),
  operation => operation.source
);

const generate = new URL('./.generate/', import.meta.url);
rmSync(generate, { recursive: true, force: true });
mkdirSync(generate);
// The Client's operation tree: the current spec's order, and which source each version is generated from.
writeFileSync(
  new URL('operations.json', generate),
  `${JSON.stringify(
    {
      order: operations.order,
      versioned: operations.versioned.map(({ operationId, version, source }) => ({ operationId, version, source })),
      versionless: operations.versionless.map(({ operationId }) => ({ operationId }))
    },
    null,
    2
  )}\n`
);

const job = (source: string, input: UserConfig['input'], keys: string[]): UserConfig => ({
  input,
  // Hey API needs an output folder; nothing the Swift SDK uses is written there.
  output: { path: `./.generate/hey-api/${source}` },
  parser: { filters: { operations: { include: keys } } },
  plugins: [rustManifest({ source, file: `./.generate/manifests/${source}.json` })]
});

export default defineConfig([
  job(
    CURRENT,
    spec,
    operations.versionless.map(operation => operation.key)
  ),
  ...[...snapshots].map(([source, defined]) =>
    job(
      source,
      { path: defined[0]!.document },
      defined.map(operation => operation.key)
    )
  )
]);
