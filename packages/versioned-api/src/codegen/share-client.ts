import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// An SDK's version folders are generated without hey-api's client runtime (`bundle: false` on their
// `@hey-api/client-fetch`), so their imports name the runtime's package. That package is not installed: its runtime is
// the one bundled into src/generated/client, which these imports are pointed at, so every contract shares one copy.

/** The package the version folders import their client runtime from. */
const RUNTIME_PACKAGE = '@hey-api/client-fetch';

/** Point every runtime import under `sdk`'s src/versions at src/generated/client. */
export function shareClient(sdk: string) {
  const versions = join(sdk, 'src', 'versions');
  const runtime = join(sdk, 'src', 'generated', 'client', 'index.js');
  const files = readdirSync(versions, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts'));
  for (const file of files) {
    const path = join(versions, file);
    const source = readFileSync(path, 'utf8');
    const specifier = relative(dirname(path), runtime);
    const shared = source.replaceAll(`from '${RUNTIME_PACKAGE}'`, `from '${specifier}'`);
    if (shared !== source) writeFileSync(path, shared);
  }
}
