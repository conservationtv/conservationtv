import {
  compatibilityChanges,
  contractsOf,
  ReleaseDocumentSchema,
  type ReleaseDocument
} from '@conservationtv/versioned-api/contracts/compare';
import { z } from 'zod';
import type { ContractChange, ReviewFile } from '../shared/review.ts';
import { GitHubError, useGitHub } from './github.ts';

const DOCUMENT = /\/contracts\/openapi\.json$/;

export async function documentAt(sha: string, path: string): Promise<ReleaseDocument> {
  const github = useGitHub();
  const text = await github.raw(sha, path);
  return ReleaseDocumentSchema.parse(JSON.parse(text));
}

/** A document that may not exist at a commit, such as an API's before it was first generated: empty there. */
export async function documentOrEmpty(sha: string, path: string): Promise<ReleaseDocument> {
  try {
    return await documentAt(sha, path);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return {};
    throw error;
  }
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
  'x-operation-contracts': z.array(ReleaseDocumentSchema).catch([])
});
export type Paths = z.output<typeof PathsSchema>;

export interface Located {
  method: string;
  path: string;
  operation: Operation;
  /** The operation and its path item as written, and the document their references point into. */
  raw: z.output<ReturnType<typeof z.json>>;
  item: Record<string, z.output<ReturnType<typeof z.json>>>;
  document: ReleaseDocument;
}

function* operationsIn(document: ReleaseDocument): Generator<Located> {
  const { paths } = PathsSchema.parse(document);
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, raw] of Object.entries(item)) {
      const operation = OperationSchema.safeParse(raw);
      if (operation.success)
        yield { method: method.toUpperCase(), path, operation: operation.data, raw, item, document };
    }
  }
}

/** Where `operationId@version` is served, and what it says of itself, from whichever document still has it. */
export function locate(documents: readonly ReleaseDocument[], key: string): Located | undefined {
  const at = key.lastIndexOf('@');
  const id = key.slice(0, at);
  const version = Number(key.slice(at + 1));
  const all = documents.flatMap(document => [document, ...PathsSchema.parse(document)['x-operation-contracts']]);
  for (const document of all) {
    for (const located of operationsIn(document)) {
      if (located.operation.operationId === id && located.operation['x-operation-version'] === version) return located;
    }
  }
  return undefined;
}

/** A canonical contract, as the checks compare it, laid out to be read and diffed. */
export function pretty(contract: string): string {
  return `${JSON.stringify(JSON.parse(contract), null, 2)}\n`;
}

/**
 * Each API document's operation contracts, compared as the `contracts` check compares them: a new operation version
 * is added; a changed or removed one breaks clients that already require it.
 */
async function documentChanges(file: ReviewFile, mergeBaseSha: string, headSha: string): Promise<ContractChange[]> {
  const previous = file.status === 'added' ? {} : await documentAt(mergeBaseSha, file.previousPath ?? file.path);
  const current = file.status === 'removed' ? {} : await documentAt(headSha, file.path);
  const before = contractsOf(previous);
  const added = [...contractsOf(current).keys()]
    .filter(operation => !before.has(operation))
    .map(operation => ({ operation, kind: 'added' as const }));
  const changes = [...compatibilityChanges(previous, current), ...added];
  return changes
    .map(change => {
      // Described by whichever document still has it: the old one, for a removed operation.
      const located = locate([current, previous], change.operation);
      return {
        document: file.path,
        ...change,
        method: located?.method ?? '',
        path: located?.path ?? '',
        summary: located?.operation.summary ?? null,
        description: located?.operation.description ?? null
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
