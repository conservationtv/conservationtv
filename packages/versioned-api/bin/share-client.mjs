#!/usr/bin/env node
// `share-client`, run from an SDK's directory after `openapi-ts`: see src/codegen/share-client.ts. The package is
// consumed from source, so it runs with tsx registered.
import { register } from 'tsx/esm/api';

register();
const { shareClient } = await import('../src/codegen/share-client.ts');
shareClient(process.cwd());
