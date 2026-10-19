import { defineConfig, type UserConfig } from '@hey-api/openapi-ts';

// Generates src/generated from the documents scripts/generate.ts derives from MediaMTX's OpenAPI spec. Run
// `pnpm generate` rather than openapi-ts alone.
//
// - spec/config.json → src/generated: the config's types and Zod schemas.
// - spec/api.json → src/generated/api: the API's types and a fetch client, in the shape of the other SDKs.

const config: UserConfig = {
  input: './spec/config.json',
  output: { path: './src/generated', module: { extension: '.js' } },
  plugins: [
    '@hey-api/typescript',
    // PascalCase with a `Schema` suffix, like the SDKs' schemas.
    { name: 'zod', metadata: true, case: 'PascalCase', definitions: '{{name}}Schema' }
  ]
};

const api: UserConfig = {
  input: './spec/api.json',
  output: { path: './src/generated/api', module: { extension: '.js' } },
  plugins: [
    '@hey-api/typescript',
    '@hey-api/client-fetch',
    {
      name: '@hey-api/sdk',
      paramsStructure: 'flat',
      // One class with a method per operation, named as the spec names them: `pathsList`, `configGlobalGet`.
      operations: { strategy: 'single', containerName: 'MediamtxApi', methods: 'instance' }
    }
  ]
};

export default defineConfig([config, api]);
