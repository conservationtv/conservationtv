import { defineContracts } from '@conservationtv/versioned-api/contracts';
import app, { operationRouter } from './src/app.ts';
import { specOptions } from './src/openapi.ts';
import * as schemas from './src/schemas.ts';

// `api-contracts generate` writes openapi.json from these routes and their handlers' types; the snapshot and release
// commands freeze and check it under contracts/snapshots/ as agent-api-vX.Y.Z.
export default defineContracts({ app, router: operationRouter, spec: specOptions, schemas, release: 'agent-api' });
