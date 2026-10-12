import { readFileSync } from 'node:fs';
import { ReleaseDocumentSchema, checkReleasedContracts, checkSnapshotFiles, releaseName } from './release-contracts.ts';

const baseIndex = process.argv.indexOf('--base');
checkSnapshotFiles(baseIndex === -1 ? 'HEAD' : process.argv[baseIndex + 1]);
const current = readFileSync(new URL('../openapi.json', import.meta.url));
checkReleasedContracts(ReleaseDocumentSchema.parse(JSON.parse(current.toString())));
const tagIndex = process.argv.indexOf('--tag');
if (tagIndex !== -1) {
  const name = releaseName(process.argv[tagIndex + 1]);
  const snapshot = readFileSync(new URL(`../snapshots/${name}.json`, import.meta.url));
  if (!current.equals(snapshot)) throw new Error(`${name}: committed snapshot differs from openapi.json`);
}
console.log('Release contracts and snapshot immutability checked.');
