import { toCase } from '@hey-api/openapi-ts';
import type { OperationField } from '../client/index.js';
import type {
  BodySchema,
  Method,
  Parameter,
  PathItem,
  RequestBody,
  SpecDocument,
  SpecOperation
} from './operation-versions.js';

// A call's fields, read from a contract as its document spells it. The generated Client holds every version's fields,
// though the job that writes it parses the current spec alone, so they are read here rather than from Hey API's parsed
// model. `flatParams` checks them against that model in the job of each contract: the two follow the same rules, which
// are @hey-api/sdk 0.99.0's for a flat signature.

const locations = ['header', 'path', 'query'] as const;
type Location = (typeof locations)[number] | 'body';

/** A member of the flat parameters before it is named: where it goes, and what the request calls it. */
export interface Member {
  location: Location;
  key: string;
  whole?: boolean;
}

/** A JSON Pointer segment as the name it spells. */
function unescape(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The component a `$ref` names, among the document's components of one kind. */
function referenced<Component>(
  components: Record<string, Component> | undefined,
  kind: string,
  reference: string
): Component {
  const prefix = `#/components/${kind}/`;
  const name = reference.startsWith(prefix) ? unescape(reference.slice(prefix.length)) : undefined;
  const found = name === undefined ? undefined : components?.[name];
  if (!found) throw new Error(`Unsupported reference: ${reference}`);
  return found;
}

/** A parameter itself, where the spec only refers to it. */
function parameterOf(document: SpecDocument, parameter: Parameter): Parameter {
  if (parameter.$ref === undefined) return parameter;
  return referenced(document.components?.parameters, 'parameters', parameter.$ref);
}

/** The header, path and query parameters, the operation's own replacing its path's of the same name and place. */
function parameterMembers(document: SpecDocument, item: PathItem, operation: SpecOperation): Member[] {
  const parameters = new Map<string, Member>();
  for (const listed of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = parameterOf(document, listed);
    const location = locations.find(candidate => candidate === parameter.in);
    // A cookie is no parameter of a call, and a parameter needs its name.
    if (!location || parameter.name === undefined) continue;
    parameters.set(`${location} ${parameter.name}`, { location, key: parameter.name });
  }
  const members = [...parameters.values()];
  return locations.flatMap(location => members.filter(member => member.location === location));
}

/** The schema of a request body, if it has any content. Client sends every body as JSON, so it must offer that. */
function bodySchema(document: SpecDocument, id: string, listed: RequestBody | undefined): BodySchema | undefined {
  if (!listed) return undefined;
  const reference = listed.$ref;
  const body =
    reference === undefined ? listed : referenced(document.components?.requestBodies, 'requestBodies', reference);
  const content = Object.entries(body.content ?? {});
  if (!content.length) return undefined;
  const json = content.find(([type]) => /[/+]json\b/.test(type));
  if (!json) throw new Error(`Unsupported request body, not JSON: ${id}`);
  return json[1].schema ?? {};
}

/** Whether a body is an inline object, whose properties are the call's parameters rather than the body whole. */
function flattens(schema: BodySchema): boolean {
  const combined = schema.allOf ?? schema.anyOf ?? schema.oneOf;
  return schema.type === 'object' && schema.properties !== undefined && !combined && !schema.nullable;
}

/** An inline object body's properties; any other body whole, under its schema's name or `body`. */
function bodyMembers(schema: BodySchema): Member[] {
  if (flattens(schema)) return Object.keys(schema.properties ?? {}).map(key => ({ location: 'body', key }));
  const name = schema.$ref?.split('/').pop();
  const key = name === undefined ? 'body' : toCase(unescape(name), 'camelCase');
  return [{ location: 'body', key, whole: true }];
}

/** A member's name in a call: its own, or told apart by its place (`path_id`) when another member shares it. */
function nameOf(member: Member, members: Member[]): string {
  const shared = members.filter(other => other.key === member.key).length > 1;
  // A whole body without a schema name is always `body`, as Hey API has it.
  const anonymous = member.whole === true && member.key === 'body';
  return shared && !anonymous ? `${member.location}_${member.key}` : member.key;
}

/** A member as a field: the whole body, or a place in the request and the name it has there when a call's differs. */
function fieldOf(member: Member, key: string): OperationField {
  if (member.whole) return { key, map: 'body' };
  const place = member.location === 'header' ? 'headers' : member.location;
  return key === member.key ? { in: place, key } : { in: place, key, map: member.key };
}

/** Members as the fields of a call, each under the name the call gives it. */
export function named(members: Member[]): OperationField[] {
  return members.map(member => fieldOf(member, nameOf(member, members)));
}

/** The fields of an operation: a call's flat parameters, placed in the request. */
export function operationFields(
  document: SpecDocument,
  item: PathItem,
  operation: SpecOperation,
  id: string
): OperationField[] {
  const schema = bodySchema(document, id, operation.requestBody);
  const body = schema ? bodyMembers(schema) : [];
  return named([...parameterMembers(document, item, operation), ...body]);
}

/** The fields of the operation a document has at `path` and `method`. */
export function fieldsAt(document: SpecDocument, path: string, method: Method, id: string): OperationField[] {
  const item = document.paths?.[path];
  const operation = item?.[method];
  if (!item || !operation) throw new Error(`Missing ${method.toUpperCase()} ${path} in the spec: ${id}`);
  return operationFields(document, item, operation, id);
}

/** Whether two readings of an operation agree, whatever order each lists its fields in. */
export function sameFields(a: OperationField[], b: OperationField[]): boolean {
  const spelled = (fields: OperationField[]) => fields.map(field => JSON.stringify(field)).sort();
  return JSON.stringify(spelled(a)) === JSON.stringify(spelled(b));
}
