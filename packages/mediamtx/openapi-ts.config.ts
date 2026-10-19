import { defineConfig } from '@hey-api/openapi-ts';

// Generates src/generated (the config's types and Zod schemas) from spec/config.json, which scripts/generate.ts derives
// from MediaMTX's OpenAPI spec. Run `pnpm generate` rather than openapi-ts alone.
export default defineConfig({
  input: './spec/config.json',
  output: { path: './src/generated', module: { extension: '.js' } },
  plugins: [
    '@hey-api/typescript',
    // PascalCase with a `Schema` suffix, like the SDKs' schemas.
    { name: 'zod', metadata: true, case: 'PascalCase', definitions: '{{name}}Schema' }
  ]
});
