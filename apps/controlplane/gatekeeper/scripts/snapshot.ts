// Regenerate first; freeze a complete release bundle and never overwrite an existing snapshot.
import { constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { ReleaseDocumentSchema, checkReleasedContracts, checkSnapshotFiles, releaseName } from './release-contracts.ts';

const name = releaseName(process.argv[2]);
checkSnapshotFiles();
await import('./openapi.ts');
const current = new URL('../openapi.json', import.meta.url);
checkReleasedContracts(ReleaseDocumentSchema.parse(JSON.parse(readFileSync(current, 'utf8'))));
const directory = new URL('../snapshots/', import.meta.url);
mkdirSync(directory, { recursive: true });
copyFileSync(current, new URL(`${name}.json`, directory), constants.COPYFILE_EXCL);
console.log(`Wrote snapshots/${name}.json. Commit it in the release PR, then tag that commit ${name}.`);
