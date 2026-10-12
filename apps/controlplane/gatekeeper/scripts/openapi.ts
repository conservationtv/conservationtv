// Each served version gets a complete standalone OpenAPI document inside the release bundle. The top-level paths
// describe the defaults for plain clients; x-operation-contracts is the complete catalog for version-aware tools.
import { writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { z } from 'zod';
import { generateSpecs } from 'hono-openapi';
import app, { operationRouter } from '../src/app.ts';
import { specOptions } from '../src/openapi.ts';
import { createResponseInferrer } from './infer-responses.ts';

const MethodSchema = z.enum(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
type Method = z.output<typeof MethodSchema>;
function operationAt(document: Awaited<ReturnType<typeof generateSpecs>>, path: string, method: string) {
  const key: Method = MethodSchema.parse(method.toLowerCase());
  return document.paths?.[path]?.[key];
}

const inferResponses = createResponseInferrer();
const owned = new Set(operationRouter.operations.flatMap(operation => operation.routes));
const common = app.routes.filter(route => !owned.has(route));
const latest = new Map<string, (typeof operationRouter.operations)[number]>();
for (const operation of operationRouter.operations) {
  // Select the newest default, while keeping each declared version for the separate catalog.
  const previous = latest.get(operation.operationId);
  if (!previous || (operation.version ?? 0) > (previous.version ?? 0)) latest.set(operation.operationId, operation);
}
async function documentFor(routes: typeof app.routes) {
  const projection = new Hono();
  projection.routes = routes;
  const document = await generateSpecs(projection, specOptions);
  inferResponses(document);
  return document;
}
const document = await documentFor([...common, ...[...latest.values()].flatMap(operation => operation.routes)]);
const contracts = [];
for (const operation of operationRouter.operations) {
  if (operation.version === undefined) continue;
  const contract = await documentFor([...common, ...operation.routes]);
  // Each catalog document contains exactly this method/path and its required version selector.
  const path = operation.path.replace(/:(\w+)/g, '{$1}');
  const entry = operationAt(contract, path, operation.method);
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
  contracts.push(contract);
}
for (const selected of latest.values()) {
  // Find the generated default by its known method and path, then advertise all served versions.
  const path = selected.path.replace(/:(\w+)/g, '{$1}');
  const operation = operationAt(document, path, selected.method);
  if (!operation) continue;
  const served = operationRouter.operations
    .filter(candidate => candidate.operationId === selected.operationId)
    .flatMap(candidate => candidate.version ?? [])
    .sort((a, b) => a - b);
  if (served.length) Object.assign(operation, { 'x-operation-versions': served });
}
const bundle = { ...document, 'x-operation-contracts': contracts };
writeFileSync(new URL('../openapi.json', import.meta.url), `${JSON.stringify(bundle, null, 2)}\n`);
