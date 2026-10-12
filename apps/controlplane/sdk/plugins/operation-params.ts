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
