import { defineConfig } from 'oxlint';

/**
 * React Compiler (both React apps' vite.config.ts) memoises components, values and callbacks itself, so hand-written
 * memoisation only adds dependency lists to keep right. Banning the named imports also refuses `import * as React`,
 * so house code imports React's exports by name; the property ban catches `React.useMemo` through a default import.
 */
const compilerMemoisation = {
  names: ['useMemo', 'useCallback', 'memo'],
  message: 'React Compiler memoises for you: write the plain value, function or component instead.'
};

const restrictedMemoisation = {
  name: 'react',
  importNames: compilerMemoisation.names,
  message: compilerMemoisation.message
};

/** The repository's own style and the anti-slop checks, for code written here. */
const houseRules = {
  'init-declarations': ['error', 'always'],
  'no-restricted-imports': ['error', { paths: [restrictedMemoisation] }],
  'no-restricted-properties': [
    'error',
    ...compilerMemoisation.names.map(property => ({ object: 'React', property, message: compilerMemoisation.message }))
  ],
  complexity: ['error', 10],
  'house/no-inline-object-type': 'error',
  'house/no-nullish-assignment': 'error',
  'house/no-object-freeze': 'error',
  'house/no-private-class-fields': 'error',
  'house/require-complexity-comment': 'error',
  'house/require-fc-component': 'error',
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
} as const;

/** The same rules, switched off: oxlint's defaults and the React rules still apply. */
const withoutHouseRules = Object.fromEntries(Object.keys(houseRules).map(rule => [rule, 'off' as const]));

/**
 * Code copied in from shadcn (`shadcn add`, its blocks and its dark-mode provider). It follows shadcn's style and is
 * replaced wholesale when re-added, so it is not held to the house rules.
 */
const vendoredFiles = [
  'packages/ui/src/components/**',
  'packages/ui/src/hooks/**',
  'packages/ui/src/lib/**',
  'apps/studio/web/src/components/blocks/**',
  'apps/studio/web/src/components/app/theme-provider.tsx'
];

/**
 * The studio web app reads data by suspending: each query is a module-level `…QueryOptions` function with a literal
 * key, read at render with the suspense hooks under a Suspense boundary, independent ones together in
 * `useSuspenseQueries`; pages take their IDs from their `params` prop and export no loaders. Any other way in (a
 * non-suspense hook, a loader) is an exception that needs explicit approval, recorded on its disable comment.
 */
const studioWebDataRules = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        restrictedMemoisation,
        {
          name: '@tanstack/react-query',
          importNames: ['useQuery', 'useQueries', 'useInfiniteQuery'],
          message:
            'Suspend instead: useSuspenseQuery, useSuspenseQueries or useSuspenseInfiniteQuery under a Suspense boundary. Anything else needs explicit approval.'
        }
      ]
    }
  ],
  'house/no-route-loader': 'error',
  'house/parallel-suspense-queries': 'error',
  'house/query-options-declaration': 'error'
} as const;

/**
 * Shows (`*.show.tsx`, packages/shows) are composed afresh for each change in a Durable Object that hibernates
 * between them (apps/studio/api/src/shows/host.ts): a show is a pure function of its state. A timer, a socket or a
 * fetch would keep the object awake, and React state or effects would be lost when it sleeps, so neither is allowed.
 * Data comes in as props, from the state the studio API composes the show from.
 */
const showDisallowed = 'A show is a pure function of its state: pass data in as props instead.';
const showRules = {
  'no-restricted-globals': [
    'error',
    ...['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame'].map(name => ({
      name,
      message: `${showDisallowed} A timer keeps the show's object awake.`
    })),
    ...['fetch', 'WebSocket', 'EventSource'].map(name => ({
      name,
      message: `${showDisallowed} I/O keeps the show's object awake.`
    }))
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        restrictedMemoisation,
        {
          name: 'react',
          importNames: [
            'useState',
            'useReducer',
            'useEffect',
            'useLayoutEffect',
            'useInsertionEffect',
            'useSyncExternalStore',
            'useTransition',
            'useActionState',
            'useOptimistic',
            'use'
          ],
          message: `${showDisallowed} A show keeps no state and runs no effects: each change composes it anew.`
        }
      ]
    }
  ]
} as const;

/** The React apps and the components they share. */
const reactFiles = ['apps/studio/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}', 'tools/review/src/app/**/*.{ts,tsx}'];

/**
 * React Router route modules export these alongside the component; the framework handles them for Fast Refresh, so
 * they must not trip `only-export-components`.
 */
const routeModuleExports = [
  'meta',
  'links',
  'headers',
  'handle',
  'loader',
  'clientLoader',
  'action',
  'clientAction',
  'middleware',
  'clientMiddleware',
  'shouldRevalidate',
  'Layout',
  'HydrateFallback',
  'ErrorBoundary'
];

export default defineConfig({
  ignorePatterns: [
    '**/dist',
    '**/bin',
    '**/.cloudflare',
    '**/.wrangler',
    '**/build',
    '**/.react-router',
    // The lint rules themselves; the other tools are linted like any package.
    'tools/oxlint',
    'node_modules',
    'target',
    // Generated from the gatekeeper's OpenAPI bundle; edit the routes or generators instead.
    'apps/controlplane/sdk/src/generated',
    'apps/controlplane/sdk/src/versions',
    'apps/controlplane/cli/src/generated',
    // Generated from the studio API's OpenAPI bundle; edit the routes or generators instead.
    'apps/studio/sdk/src/generated',
    'apps/studio/sdk/src/versions',
    'apps/studio/cli/src/generated',
    // Generated from the agent API's OpenAPI bundle; edit the routes or generators instead.
    'apps/agent/sdk/src/generated',
    'apps/agent/sdk/src/versions',
    'apps/agent/cli/src/generated',
    // Generated from MediaMTX's OpenAPI spec; edit packages/mediamtx/scripts/generate.ts instead.
    'packages/mediamtx/src/generated',
    // Generated by `pulumi package add terraform-provider planetscale/planetscale`.
    'apps/controlplane/infrastructure/sdks'
  ],
  jsPlugins: [
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
    { name: 'house', specifier: './tools/oxlint/house/index.ts' }
  ],
  rules: houseRules,
  overrides: [
    // Before the vendored files' override, which switches house rules off again for the copied-in shadcn code.
    { files: ['apps/studio/web/src/**/*.{ts,tsx}'], rules: studioWebDataRules },
    { files: vendoredFiles, rules: withoutHouseRules },
    { files: ['**/*.show.tsx'], rules: showRules },
    {
      // The rules of eslint-plugin-react-hooks' `recommended-latest` (hooks and React Compiler) and
      // eslint-plugin-react-refresh, which oxlint implements natively. `config` and `gating` only validate a Babel
      // React Compiler setup, which these apps don't use.
      files: reactFiles,
      plugins: ['react'],
      rules: {
        'react/rules-of-hooks': 'error',
        'react/exhaustive-deps': 'warn',
        'react/static-components': 'error',
        'react/use-memo': 'error',
        'react/void-use-memo': 'error',
        'react/preserve-manual-memoization': 'error',
        'react/incompatible-library': 'warn',
        'react/immutability': 'error',
        'react/globals': 'error',
        'react/refs': 'error',
        'react/set-state-in-effect': 'error',
        'react/error-boundaries': 'error',
        'react/purity': 'error',
        'react/set-state-in-render': 'error',
        'react/unsupported-syntax': 'warn',
        'react/only-export-components': ['warn', { allowConstantExport: true, allowExportNames: routeModuleExports }]
      }
    }
  ]
});
