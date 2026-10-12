import { defineConfig } from 'oxlint';

export default defineConfig({
  ignorePatterns: [
    '**/dist',
    '**/bin',
    '**/.cloudflare',
    '**/.wrangler',
    'tools',
    'node_modules',
    'target',
    // Generated from the gatekeeper's OpenAPI bundle; edit the routes or generators instead.
    'apps/controlplane/sdk/src/generated',
    'apps/controlplane/sdk/src/versions',
    'apps/controlplane/cli/src/generated'
  ],
  jsPlugins: [
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
    { name: 'house', specifier: './tools/oxlint/house/index.ts' }
  ],
  rules: {
    'init-declarations': ['error', 'always'],
    complexity: ['error', 10],
    'house/no-inline-object-type': 'error',
    'house/no-nullish-assignment': 'error',
    'house/no-object-freeze': 'error',
    'house/no-private-class-fields': 'error',
    'house/require-complexity-comment': 'error',
    'house/require-pascal-case-schema-name': 'error',
    'house/require-zod-output-type': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error'
  }
});
