// Each served version gets a complete standalone OpenAPI document inside the release bundle. The top-level paths
// describe the defaults for plain clients; x-operation-contracts is the complete catalog for version-aware tools.
// Beside the bundle, the operation manifest lists only the versions each operation serves, which is all a handshake needs.
import { writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { z } from 'zod';
import { generateSpecs } from 'hono-openapi';
import type { OperationManifest } from '../server/published-document.js';
import type { OperationRoute, OperationRouter } from '../server/operation-router.js';
import type { ContractsProject } from './config.js';
import { createResponseInferrer, type GeneratedDocument } from './infer-responses.js';

const MethodSchema = z.enum(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
type Method = z.output<typeof MethodSchema>;
function operationAt(document: GeneratedDocument, path: string, method: string) {
  const key: Method = MethodSchema.parse(method.toLowerCase());
  return document.paths?.[path]?.[key];
}

const toTemplate = (path: string) => path.replace(/:(\w+)/g, '{$1}');

/** The newest declared version of each operation: the default for plain clients. */
function latestOperations(router: OperationRouter): Map<string, OperationRoute> {
  const latest = new Map<string, OperationRoute>();
  for (const operation of router.operations) {
    // A versionless operation has one route; versioned ones keep the highest declared version.
    const previous = latest.get(operation.operationId);
    if (!previous || (operation.version ?? 0) > (previous.version ?? 0)) latest.set(operation.operationId, operation);
  }
  return latest;
}

/** Each catalog document contains exactly one method/path and its required version selector. */
function selectVersion(contract: GeneratedDocument, operation: OperationRoute): void {
  const entry = operationAt(contract, toTemplate(operation.path), operation.method);
  if (!entry) throw new Error(`${operation.operationId}: generated contract is missing`);
  entry.parameters = [
    ...(entry.parameters ?? []),
    {
      in: 'header',
      name: 'Operation-Version',
      required: true,
      description: 'Selects this immutable operation contract.',
      schema: { type: 'string', const: String(operation.version) }
    }
  ];
}

/** Every served version of each versioned operation, ascending, in the order the router registered them. */
function servedVersions(router: OperationRouter): Map<string, number[]> {
  const served = new Map<string, number[]>();
  for (const operation of router.operations) {
    if (operation.version === undefined) continue;
    const versions = served.get(operation.operationId) ?? [];
    versions.push(operation.version);
    served.set(operation.operationId, versions);
  }
  for (const versions of served.values()) versions.sort((a, b) => a - b);
  return served;
}

/** Advertise every served version on each default operation, found by its known method and path. */
function advertiseVersions(
  document: GeneratedDocument,
  served: Map<string, number[]>,
  latest: Iterable<OperationRoute>
) {
  for (const selected of latest) {
    const operation = operationAt(document, toTemplate(selected.path), selected.method);
    const versions = served.get(selected.operationId);
    if (operation && versions) Object.assign(operation, { 'x-operation-versions': versions });
  }
}

/** Generate the release bundle and the operation manifest, and write them to the project's paths. */
export async function generateBundle(project: ContractsProject): Promise<void> {
  const { app, router, spec } = project;
  const inferResponses = createResponseInferrer(project);
  const owned = new Set(router.operations.flatMap(operation => operation.routes));
  const common = app.routes.filter(route => !owned.has(route));
  const latest = latestOperations(router);
  const documentFor = async (routes: typeof app.routes) => {
    const projection = new Hono();
    projection.routes = routes;
    const document = await generateSpecs(projection, spec);
    inferResponses(document);
    return document;
  };
  const document = await documentFor([...common, ...[...latest.values()].flatMap(operation => operation.routes)]);
  const contracts = [];
  for (const operation of router.operations) {
    if (operation.version === undefined) continue;
    const contract = await documentFor([...common, ...operation.routes]);
    selectVersion(contract, operation);
    contracts.push(contract);
  }
  const served = servedVersions(router);
  advertiseVersions(document, served, latest.values());
  const bundle = { ...document, 'x-operation-contracts': contracts };
  writeFileSync(project.document, `${JSON.stringify(bundle, null, 2)}\n`);
  // The handshake reads only this: a few kilobytes, where the bundle is hundreds.
  const manifest: OperationManifest = { operations: Object.fromEntries(served) };
  const manifestText = JSON.stringify(manifest, null, 2);
  writeFileSync(project.manifest, `${manifestText}\n`);
}
