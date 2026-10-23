import type { SchemaNode } from '../shared/operation.ts';

// Reading JSON Schemas as documentation: a type as a reader writes it, the limits on a value, and how one field
// differs from the same field before.

/** How a field changed: only marked on an operation that existed before, where a change can break a client. */
export type Mark = 'added' | 'removed' | 'changed' | null;

function literal<T>(value: T): string {
  return JSON.stringify(value);
}

/** Variants that are not just `null`, and whether `null` was one of them. */
function variants(node: SchemaNode): [SchemaNode[], boolean] {
  const all = node.oneOf ?? node.anyOf ?? [];
  const values = all.filter(variant => variant.type !== 'null');
  return [values, values.length < all.length];
}

function primitive(node: SchemaNode): string {
  const types = [node.type ?? 'any'].flat();
  return types.map(type => (type === 'string' && node.format ? `string<${node.format}>` : type)).join(' | ');
}

/** The field an object variant is told apart by, such as `driver: "axis"`: the first one with a constant value. */
function discriminant(node: SchemaNode): string | undefined {
  const entry = Object.entries(node.properties ?? {}).find(([, field]) => field.const !== undefined);
  return entry ? `${entry[0]}: ${literal(entry[1].const)}` : undefined;
}

/** A map's value schema: an object with no fields of its own whose every key holds the same kind of value. */
function mapValue(node: SchemaNode): SchemaNode | undefined {
  const value = node.additionalProperties;
  return !node.properties && value !== undefined && value !== true && value !== false ? value : undefined;
}

/** The objects a value may be one of, when it may be one of several. */
export function objectVariants(node: SchemaNode | undefined): SchemaNode[] {
  if (!node) return [];
  // The variants an array's items or a map's values may be.
  const inner = node.items ?? mapValue(node);
  if (inner) return objectVariants(inner);
  const [values] = variants(node);
  return values.filter(value => value.properties);
}

/** Any JSON value at all, as Zod writes one: strings, numbers, booleans, null, and arrays and maps of itself. */
function isJson(node: SchemaNode): boolean {
  const kinds = new Set((node.anyOf ?? node.oneOf ?? []).flatMap(variant => [variant.type ?? 'object'].flat()));
  return ['string', 'number', 'boolean', 'null', 'array', 'object'].every(kind => kinds.has(kind));
}

/** An object's name: its component's, else the field its variant is told apart by, else just `object`. */
function objectLabel(node: SchemaNode): string {
  const tag = discriminant(node);
  return node['x-ref'] ?? (tag ? `{ ${tag} }` : 'object');
}

/** A value made of others: one of several, an array of them, a map of them, or an object; null for a plain value. */
function compositeLabel(node: SchemaNode): string | null {
  const [values, nullable] = variants(node);
  if (values.length) return `${values.map(typeLabel).join(' | ')}${nullable ? ' | null' : ''}`;
  if (node.items) return `${typeLabel(node.items)}[]`;
  const value = mapValue(node);
  if (value) return `{ [key]: ${typeLabel(value)} }`;
  return node.properties || node.type === 'object' ? objectLabel(node) : null;
}

/** `string<uuid>`, `Camera[]`, `"idle" | "active"`, `Gateway | null`: a value's type as a reader writes it. */
export function typeLabel(node: SchemaNode): string {
  // Any JSON, a schema that refers back to itself, a literal or a set of them, before what it is made of.
  if (isJson(node) || node['x-ref']?.startsWith('__')) return 'JSON';
  if (node['x-recursive']) return node['x-ref'] ?? 'object';
  if (node.const !== undefined) return literal(node.const);
  if (node.enum) return node.enum.map(literal).join(' | ');
  return compositeLabel(node) ?? primitive(node);
}

/** `1–120 characters`, `≥ 0`, `≤ 256 characters`: a range, its unit after it when it has one. */
function range(low: number | undefined, high: number | undefined, unit: string): string | null {
  const suffix = unit ? ` ${unit}` : '';
  if (low !== undefined && high !== undefined) return low === high ? `${low}${suffix}` : `${low}–${high}${suffix}`;
  if (low !== undefined) return `≥ ${low}${suffix}`;
  if (high !== undefined) return `≤ ${high}${suffix}`;
  return null;
}

/** The limits on a value: lengths, bounds, item counts, a pattern, a default. */
export function constraints(node: SchemaNode): string[] {
  return [
    range(node.minLength, node.maxLength, 'characters'),
    range(node.minimum, node.maximum, ''),
    range(node.minItems, node.maxItems, 'items'),
    // A format such as `uuid` says what its pattern spells out.
    node.pattern && !node.format ? `pattern ${node.pattern}` : null,
    node.default !== undefined ? `default ${literal(node.default)}` : null
  ].filter(entry => entry !== null);
}

/** The schema whose fields a value has: an object's, an array's items', or a nullable object's. */
export function fieldsOf(node: SchemaNode | undefined): SchemaNode | undefined {
  if (!node) return undefined;
  if (node.properties) return node;
  if (node.items) return fieldsOf(node.items);
  const value = mapValue(node);
  if (value) return fieldsOf(value);
  const [values] = variants(node);
  return values.length === 1 ? fieldsOf(values[0]) : undefined;
}

/** Everything a client depends on, prose left out. */
export function signature<T>(node: T): string {
  return JSON.stringify(node ?? null, (key, value) => (key === 'description' ? undefined : value));
}

/** The value itself, its fields left out: what a field row shows. */
function own(node: SchemaNode): string {
  const { properties: _properties, items: _items, oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = node;
  return signature({ ...rest, label: typeLabel(node) });
}

/** New, gone, or different in what it is or whether it is required; null when the field itself is the same. */
export function markOf(
  before: SchemaNode | undefined,
  after: SchemaNode | undefined,
  required: [boolean, boolean]
): Mark {
  if (!before) return 'added';
  if (!after) return 'removed';
  return own(before) !== own(after) || required[0] !== required[1] ? 'changed' : null;
}
