import { defineContracts } from '@conservationtv/versioned-api/contracts';
import app, { operationRouter } from './src/api/app.ts';
import { specOptions } from './src/api/openapi.ts';
import * as schemas from './src/api/schemas.ts';

// `api-contracts generate` writes openapi.json from these routes and their handlers' types; the snapshot and release
// commands freeze and check it under contracts/snapshots/ as vX.Y.Z, the version every API releases under together.
export default defineContracts({
  app,
  router: operationRouter,
  spec: specOptions,
  schemas,
  // The API lives under src/api/, beside the agent that serves it.
  source: { dir: 'src/api' }
});
