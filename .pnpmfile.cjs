// TypeScript 7 has no JS compiler API. Hey API prints its output with it and Pulumi serialises closures with it, so
// their TypeScript peer, which would resolve to the workspace's TypeScript 7, becomes a TypeScript 6 of their own.
const COMPILER_API_USERS = new Set(['@hey-api/openapi-ts', '@pulumi/pulumi']);
const COMPILER_API_TYPESCRIPT = '6.0.3';

function readPackage(manifest) {
  if (!COMPILER_API_USERS.has(manifest.name)) return manifest;
  delete manifest.peerDependencies?.typescript;
  delete manifest.peerDependenciesMeta?.typescript;
  manifest.dependencies = { ...manifest.dependencies, typescript: COMPILER_API_TYPESCRIPT };
  return manifest;
}

module.exports = { hooks: { readPackage } };
