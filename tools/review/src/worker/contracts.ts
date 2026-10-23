import {
  compatibilityChanges,
  contractsOf,
  ReleaseDocumentSchema,
  type ReleaseDocument
} from '@conservationtv/versioned-api/contracts/compare';
import { z } from 'zod';
import type { ContractChange, ReviewFile } from '../shared/review.ts';
import { useGitHub } from './github.ts';

const DOCUMENT = /\/contracts\/openapi\.json$/;

async function documentAt(sha: string, path: string): Promise<ReleaseDocument> {
  const github = useGitHub();
  const text = await github.raw(sha, path);
  return ReleaseDocumentSchema.parse(JSON.parse(text));
}

// An API document as far as finding an operation in it goes: the current operations under `paths`, and every
// version still served, each in its own document, under `x-operation-contracts`.
const OperationSchema = z.object({
  operationId: z.string(),
  'x-operation-version': z.int(),
  summary: z.string().optional(),
  description: z.string().optional()
});
type Operation = z.output<typeof OperationSchema>;
const PathsSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.json())).catch({}),
  'x-operation-contracts': z.array(z.json()).catch([])
});
type Paths = z.output<typeof PathsSchema>;

interface Located {
  method: string;
  path: string;
  operation: Operation;
}

function* operationsIn(document: Paths): Generator<Located> {
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, entry] of Object.entries(item)) {
      const operation = OperationSchema.safeParse(entry);
      if (operation.success) yield { method: method.toUpperCase(), path, operation: operation.data };
    }
  }
}

/** Where `operationId@version` is served, and what it says of itself, from whichever document still has it. */
function locate(documents: readonly ReleaseDocument[], key: string): Located | undefined {
  const at = key.lastIndexOf('@');
  const id = key.slice(0, at);
  const version = Number(key.slice(at + 1));
  const bundles = documents.map(document => PathsSchema.parse(document));
  const all = bundles.flatMap(bundle => [
    bundle,
    ...bundle['x-operation-contracts'].map(nested => PathsSchema.parse(nested))
  ]);
  for (const document of all) {
    for (const located of operationsIn(document)) {
      if (located.operation.operationId === id && located.operation['x-operation-version'] === version) return located;
    }
  }
  return undefined;
}

/** A canonical contract, as the checks compare it, laid out to be read and diffed. */
function pretty(contract: string | undefined): string | null {
  return contract === undefined ? null : `${JSON.stringify(JSON.parse(contract), null, 2)}\n`;
}

/**
 * Each API document's operation contracts, compared as the `contracts` check compares them: a new operation version
 * is added; a changed or removed one breaks clients that already require it.
 */
async function documentChanges(file: ReviewFile, mergeBaseSha: string, headSha: string): Promise<ContractChange[]> {
  const previous = file.status === 'added' ? {} : await documentAt(mergeBaseSha, file.previousPath ?? file.path);
  const current = file.status === 'removed' ? {} : await documentAt(headSha, file.path);
  const before = contractsOf(previous);
  const after = contractsOf(current);
  const added = [...after.keys()]
    .filter(operation => !before.has(operation))
    .map(operation => ({ operation, kind: 'added' as const }));
  const changes = [...compatibilityChanges(previous, current), ...added];
  return changes
    .map(change => {
      // Described by whichever document still has it (the old one, for a removed operation), with the canonical
      // contract on each side it exists on.
      const located = locate([current, previous], change.operation);
      return {
        document: file.path,
        ...change,
        method: located?.method ?? '',
        path: located?.path ?? '',
        summary: located?.operation.summary ?? null,
        description: located?.operation.description ?? null,
        before: pretty(before.get(change.operation)),
        after: pretty(after.get(change.operation))
      };
    })
    .toSorted((a, b) => a.operation.localeCompare(b.operation));
}

export async function contractChanges(
  files: readonly ReviewFile[],
  mergeBaseSha: string,
  headSha: string
): Promise<ContractChange[]> {
  const documents = files.filter(file => DOCUMENT.test(file.path));
  const changes = await Promise.all(documents.map(file => documentChanges(file, mergeBaseSha, headSha)));
  return changes.flat();
}
