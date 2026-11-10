import { toCase, type IR } from '@hey-api/openapi-ts';
import pluralize from 'pluralize';

/** The name an operation's Params exports start with: `grants.exchange` is `GrantExchange`. */
export function paramsBase(id: string): string {
  const parts = id.split('.');
  const [resource, action] = parts.slice(-2);
  if (parts.some(part => !part) || !resource || !action) {
    throw new Error(`Expected resource.action: ${id}`);
  }
  return toCase(`${pluralize.singular(resource)}.${action}`, 'PascalCase');
}

/** One flat Params member: a header, path or query parameter, a body property, or a whole non-object body. */
export interface ParamField {
  key: string;
  location: 'header' | 'path' | 'query' | 'body';
  required: boolean;
  description?: string;
  whole?: boolean;
}

export interface OperationParams {
  base: string;
  fields: ParamField[];
}

function parameterFields(operation: IR.OperationObject): ParamField[] {
  return (['header', 'path', 'query'] as const).flatMap(location =>
    Object.values(operation.parameters?.[location] ?? {}).map(parameter => ({
      key: parameter.name,
      location,
      required: parameter.required ?? false,
      description: parameter.description ?? parameter.schema.description
    }))
  );
}

/** Inline object bodies flatten into their properties; nullable or read-scoped wrappers can't, so fail instead. */
function propertyFields(id: string, schema: IR.SchemaObject): ParamField[] | undefined {
  const properties = schema.properties;
  if (schema.logicalOperator || schema.type !== 'object' || !properties) return undefined;
  if (schema.items?.some(item => item.type === 'null') || schema.accessScope === 'read') {
    throw new Error(`Unsupported wrapped inline body: ${id}`);
  }
  return Object.keys(properties).map(key => ({
    key,
    location: 'body',
    required: schema.required?.includes(key) ?? false,
    description: properties[key]?.description
  }));
}

/** An inline object body flattens into its properties; anything else is passed whole under one key. */
function bodyFields(id: string, body: IR.BodyObject): ParamField[] {
  const schema = body.schema;
  const properties = propertyFields(id, schema);
  if (properties) return properties;
  const refName = schema.$ref?.split('/').pop()?.replace(/~1/g, '/').replace(/~0/g, '~');
  return [
    {
      key: refName ? toCase(refName, 'camelCase') : 'body',
      location: 'body',
      required: body.required ?? false,
      whole: true,
      description: schema.description
    }
  ];
}

/** Shared naming and field contract for the client and CLI generation jobs. */
export function operationParams(operation: IR.OperationObject): OperationParams {
  const id = operation.operationId;
  if (!id) throw new Error(`Missing operationId: ${operation.id}`);
  const body = operation.body ? bodyFields(id, operation.body) : [];
  return { base: paramsBase(id), fields: [...parameterFields(operation), ...body] };
}

/** A ParamField under the name it has in the flat Params: its key, or `<location>_<key>` where keys repeat. */
export interface FlatField extends ParamField {
  name: string;
}

/** Field names may repeat across locations; such fields are prefixed with their location (`path_id`, `query_id`). */
function locationsByKey(fields: ParamField[]): Map<string, Set<string>> {
  const locations = new Map<string, Set<string>>();
  for (const field of fields) {
    const set = locations.get(field.key) ?? new Set<string>();
    set.add(field.location);
    locations.set(field.key, set);
  }
  return locations;
}

/**
 * Hey API 0.99.0 does not consistently disambiguate a scalar/array body's fallback 'body' key from a parameter also
 * named 'body'. Reject it rather than emit Params that send the wrong value.
 */
function rejectAmbiguousBody(operation: IR.OperationObject, fields: ParamField[], locations: Map<string, Set<string>>) {
  const wholeBody = operation.body && !operation.body.schema.$ref && fields.some(field => field.whole);
  if (wholeBody && (locations.get('body')?.size ?? 0) > 1) {
    throw new Error(`Unsupported conflicting body parameter: ${operation.operationId}`);
  }
}

/**
 * The flat Params members every SDK generator emits, in order. Only names that repeat across locations get a location
 * prefix; any remaining clash is an error, not a silent overwrite.
 */
export function flatFields(operation: IR.OperationObject, fields: ParamField[]): FlatField[] {
  const locations = locationsByKey(fields);
  rejectAmbiguousBody(operation, fields, locations);
  const emitted = new Set<string>();
  return fields.map(field => {
    // Location-prefix only names repeated across locations; any remaining clash is an error, not a silent overwrite.
    const name = (locations.get(field.key)?.size ?? 0) > 1 ? `${field.location}_${field.key}` : field.key;
    if (emitted.has(name)) throw new Error(`Ambiguous flat field ${name}: ${operation.operationId}`);
    emitted.add(name);
    return { ...field, name };
  });
}
