// Experiment: rewrite an OpenAPI 3.1 document as 3.0.3, which is all progenitor's parser (openapiv3) reads. Only the
// 3.1 features the studio API's contract uses are handled: `const`, numeric exclusive bounds, `type` arrays and
// `{ type: 'null' }` branches as `nullable`, and `propertyNames`, which 3.0 has no counterpart for and is dropped.
//
//   node downlevel.mjs <3.1 document> > <3.0 document>
import { readFileSync } from 'node:fs';

const document = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const isNull = schema => schema && typeof schema === 'object' && schema.type === 'null';

function schema(node) {
  if (Array.isArray(node)) return node.map(schema);
  if (!node || typeof node !== 'object') return node;
  const out = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, schema(value)]));
  if ('const' in out) {
    out.enum = [out.const];
    delete out.const;
  }
  for (const [bound, plain] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum']
  ]) {
    if (typeof out[bound] === 'number') {
      out[plain] = out[bound];
      out[bound] = true;
    }
  }
  if (Array.isArray(out.type)) {
    const types = out.type.filter(type => type !== 'null');
    if (types.length < out.type.length) out.nullable = true;
    if (types.length === 1) out.type = types[0];
    else {
      delete out.type;
      out.anyOf = types.map(type => ({ type }));
    }
  }
  for (const union of ['anyOf', 'oneOf']) {
    if (!Array.isArray(out[union]) || !out[union].some(isNull)) continue;
    const rest = out[union].filter(branch => !isNull(branch));
    delete out[union];
    // One remaining branch is the schema itself, made nullable; several stay a union, made nullable.
    if (rest.length === 1) Object.assign(out, rest[0].$ref ? { allOf: [rest[0]] } : rest[0]);
    else out[union] = rest;
    out.nullable = true;
  }
  delete out.propertyNames;
  delete out.$schema;
  return out;
}

// Inline union branches have no names of their own, so typify derives one from where they sit, and branches that sit
// in the same place collide: `reports.submit`'s event, metric and log payloads all became the event's. Hoist each
// branch of a union discriminated by a constant property into a component named for its operation and constant, such
// as `ReportsSubmitMetric`, so every branch's types are named apart.
const pascal = text => text.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, letter) => letter.toUpperCase());

function discriminant(branch) {
  if (!branch || typeof branch !== 'object' || branch.type !== 'object') return undefined;
  for (const property of Object.values(branch.properties ?? {})) {
    if (typeof property?.const === 'string') return property.const;
  }
  return undefined;
}

function hoist(node, prefix) {
  if (Array.isArray(node)) return node.forEach(item => hoist(item, prefix));
  if (!node || typeof node !== 'object') return;
  for (const union of ['oneOf', 'anyOf']) {
    const branches = node[union];
    if (!Array.isArray(branches) || branches.length < 2) continue;
    const names = branches.map(discriminant);
    if (names.some(name => name === undefined)) continue;
    node[union] = branches.map((branch, index) => {
      let name = `${prefix}${pascal(names[index])}`;
      while (document.components.schemas[name]) name += '_';
      document.components.schemas[name] = branch;
      hoist(branch, name);
      return { $ref: `#/components/schemas/${name}` };
    });
  }
  for (const value of Object.values(node)) hoist(value, prefix);
}

document.components ??= {};
document.components.schemas ??= {};
for (const item of Object.values(document.paths)) {
  for (const operation of Object.values(item)) {
    if (operation?.operationId) hoist(operation, pascal(operation.operationId));
  }
}

const converted = schema(document);
converted.openapi = '3.0.3';
// Zod's `z.json()` is a recursive union of every JSON type, which typify renders as a type containing itself. Any
// schema at all is the same set of values, and typify makes it `serde_json::Value`.
for (const [name, component] of Object.entries(converted.components.schemas)) {
  const self = `#/components/schemas/${name}`;
  const branches = component.anyOf ?? [];
  const recursive = branches.some(branch => branch.items?.$ref === self || branch.additionalProperties?.$ref === self);
  if (recursive && branches.every(branch => ['string', 'number', 'boolean', 'array', 'object'].includes(branch.type))) {
    converted.components.schemas[name] = { description: 'Any JSON value.' };
  }
}
// Vendor extensions at the root are fine in 3.0, but `x-operation-contracts` is large and progenitor ignores it.
delete converted['x-operation-contracts'];
process.stdout.write(JSON.stringify(converted, null, 2));
