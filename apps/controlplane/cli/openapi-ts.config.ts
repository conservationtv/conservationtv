import { createRequire } from 'node:module';
import { defineConfig } from '@hey-api/openapi-ts';
import { readOperations } from '@conservationtv/controlplane-sdk/codegen/operations';
import { incurBuilder } from './plugins/incur-builder.plugin.js';

// Generates the command builder (src/generated) from the API's OpenAPI spec. Commands parse their input with the
// client's `*ParamsSchema` exports, so the builder shares the client's operation naming (`@conservationtv/controlplane-sdk/codegen`).
// Run `pnpm generate` from the workspace root after changing a route, so the spec, SDK and CLI stay in step.
const spec = createRequire(import.meta.url).resolve('@conservationtv/gatekeeper/openapi.json');

export default defineConfig({
  input: spec,
  output: { path: './src/generated', module: { extension: '.js' }, entryFile: false },
  // Versioned operations get a command per version the client keeps, so the CLI reads the same snapshots it does.
  plugins: [incurBuilder({ clientPackage: '@conservationtv/controlplane-sdk', operations: readOperations(spec) })]
});
