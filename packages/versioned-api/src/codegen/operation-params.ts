import { toCase, type IR } from '@hey-api/openapi-ts';
import pluralize from 'pluralize';
import { z } from 'zod';
import type { OperationField } from '../client/index.js';
import { named } from './operation-fields.js';

const OperationId = 'x-operation-id';

interface NamedOperation {
  operationId?: string;
  [OperationId]?: unknown;
}

/**
 * Hey API names an operation's types after its operationId unless its own SDK plugin is configured otherwise, and this
 * SDK does not use that plugin. Passed as `parser.patch.operations`, this keeps those names the method and path's
 * (`GetOrganisationsByIdResponse`), by moving the operationId to where only `operationIdOf` reads it.
 */
export function nameByPath(_method: string, _path: string, operation: NamedOperation) {
  if (operation.operationId === undefined) return;
  operation[OperationId] = operation.operationId;
  delete operation.operationId;
}

/** An operation's operationId, wherever `nameByPath` left it. */
export function operationIdOf(operation: IR.OperationObject): string | undefined {
  const moved = z.string().safeParse(operation[OperationId]);
  return moved.data ?? operation.operationId;
}

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
  schema: IR.SchemaObject;
  description?: string;
  whole?: boolean;
}

/** A member with the name a call gives it, and where the request takes it from. */
export interface NamedField extends ParamField {
  name: string;
  field: OperationField;
}

export interface OperationParams {
  id: string;
  base: string;
  fields: NamedField[];
}

function parameterFields(operation: IR.OperationObject): ParamField[] {
  return (['header', 'path', 'query'] as const).flatMap(location =>
    Object.values(operation.parameters?.[location] ?? {}).map(parameter => ({
      key: parameter.name,
      location,
      required: parameter.required ?? false,
      schema: parameter.schema,
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
  return Object.entries(properties).map(([key, property]) => ({
    key,
    location: 'body',
    required: schema.required?.includes(key) ?? false,
    schema: property,
    description: property.description
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
      schema,
      whole: true,
      description: schema.description
    }
  ];
}

/** Shared naming and field contract for the client and CLI generation jobs. */
export function operationParams(operation: IR.OperationObject): OperationParams {
  const id = operationIdOf(operation);
  if (!id) throw new Error(`Missing operationId: ${operation.id}`);
  const body = operation.body ? bodyFields(id, operation.body) : [];
  const members = [...parameterFields(operation), ...body];
  const fields = named(members).map((field, index) => ({ ...members[index]!, name: field.key, field }));
  return { id, base: paramsBase(id), fields };
}
