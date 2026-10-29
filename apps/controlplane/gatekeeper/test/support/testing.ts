// The `@conservationtv/gatekeeper/testing` entry point: what suites outside this package (the controlplane end-to-end
// tests) need to run the built Worker with test deployment inputs. Not part of the deployed worker.
export { grants } from '../../src/db/schema.ts';
export { exampleGrant } from './consumer.ts';
export {
  connectTestDatabase,
  startWorker,
  CONSUMER_TOKEN,
  CONSUMER_NAMESPACE,
  MOQ_RELAY_TOKEN,
  MOQ_CLUSTER_TOKEN,
  RELAY_TOKEN,
  type TestDatabase
} from './harness.ts';

/** Drizzle migrations, for suites that create their own database. */
export const MIGRATIONS_FOLDER = new URL('../../drizzle', import.meta.url).pathname;
