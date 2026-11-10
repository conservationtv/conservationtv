import { $, definePluginConfig, type DefinePlugin, type IR, type Plugin } from '@hey-api/openapi-ts';
import { z } from 'zod';
import { fieldsAt, sameFields } from './operation-fields.js';
import { operationParams, type NamedField } from './operation-params.js';
import { SpecDocumentSchema, type SpecDocument } from './operation-versions.js';

interface FlatParamsUserOptions {
  name: 'flat-params';
  versionSuffix?: boolean;
}
interface FlatParamsOptions {
  name: 'flat-params';
  versionSuffix: boolean;
}
type UserConfig = FlatParamsUserOptions & Plugin.Hooks & Plugin.UserExports;
type Config = FlatParamsOptions & Plugin.Hooks & Plugin.Exports;
type FlatParamsPlugin = DefinePlugin<UserConfig, Config>;
type FlatParamsInstance = Parameters<FlatParamsPlugin['Handler']>[0]['plugin'];

const OperationVersionSchema = z.int().positive();
type OperationVersion = z.output<typeof OperationVersionSchema>;

/**
 * 0.99.0 does not consistently disambiguate a scalar/array body's fallback 'body' key from a parameter also named
 * 'body'. Reject it rather than emit Params that send the wrong value.
 */
function rejectAmbiguousBody(operation: IR.OperationObject, id: string, fields: NamedField[]) {
  const wholeBody = operation.body && !operation.body.schema.$ref && fields.some(field => field.whole);
  if (wholeBody && fields.filter(field => field.key === 'body').length > 1) {
    throw new Error(`Unsupported conflicting body parameter: ${id}`);
  }
}

/**
 * The generated Client places a call's parameters by fields read from the contract's document, not from the parsed
 * model these Params are written from. Fail rather than let the two disagree about an operation.
 */
function rejectDisagreement(document: SpecDocument, operation: IR.OperationObject, id: string, fields: NamedField[]) {
  const described = fieldsAt(document, operation.path, operation.method, id);
  const parsed = fields.map(field => field.field);
  if (!sameFields(described, parsed)) {
    const readings = `${JSON.stringify(described)}\n  ${JSON.stringify(parsed)}`;
    throw new Error(`Fields differ between the spec and its parsed model: ${id}\n  ${readings}`);
  }
}

/** The member expression for one field: the generated request-layer schema (or one of its members), described. */
function memberExpression(plugin: FlatParamsInstance, operation: IR.OperationObject, field: NamedField) {
  const layer = field.location === 'header' ? 'headers' : field.location;
  const symbol = plugin.querySymbol({
    artifact: 'zod',
    category: 'schema',
    resource: 'operation',
    resourceId: operation.id,
    role: `request-${layer}`
  });
  if (!symbol) throw new Error(`Missing Zod ${layer} schema: ${operation.id}`);
  const expression = field.whole ? $(symbol) : $(symbol).attr('shape').attr(field.key);
  const validated = expression.attr(field.required ? 'nonoptional' : 'optional').call();
  return field.description ? $(validated).attr('describe').call($.literal(field.description)) : validated;
}

/** One flat Zod object member per field. Only names that repeat across locations get a location prefix. */
function paramsMembers(plugin: FlatParamsInstance, operation: IR.OperationObject, fields: NamedField[]) {
  const members = $.object().pretty();
  for (const field of fields) members.prop(field.name, memberExpression(plugin, operation, field));
  return members;
}

/** A call's parameters as its caller writes them: each field's own type, where Params is what validation makes of it. */
function inputType(plugin: FlatParamsInstance, fields: NamedField[]) {
  const typescript = plugin.getPluginOrThrow('@hey-api/typescript');
  const input = $.type.object();
  for (const field of fields) {
    const type = typescript.api.schemaToType(typescript, field.schema);
    input.prop(field.name, member => member.required(field.required).type(type));
  }
  return input;
}

/** Any remaining clash of names is an error, not a silent overwrite. */
function rejectRepeatedNames(id: string, fields: NamedField[]) {
  const emitted = new Set<string>();
  for (const field of fields) {
    if (emitted.has(field.name)) throw new Error(`Ambiguous flat field ${field.name}: ${id}`);
    emitted.add(field.name);
  }
}

/**
 * An operation's flat parameters and what it answers: `Params` and its schema, what validation makes of a call's
 * parameters; `Input`, the parameters as a caller writes them; and `Output`, its success body. Follows
 * @hey-api/sdk 0.99.0's rules for a flat signature. Pin that version.
 */
export const flatParams = definePluginConfig<FlatParamsPlugin['Types']>({
  name: 'flat-params',
  // With `versionSuffix`, a versioned operation's names include its version (`GrantExchangeV1Params`), so the Params
  // of several spec snapshots can be exported side by side.
  config: { includeInEntry: true, versionSuffix: false },
  dependencies: ['zod', '@hey-api/typescript'],
  handler({ plugin }) {
    const zodSymbol = plugin.symbolFactory.register('z', { external: 'zod' });
    const document = SpecDocumentSchema.parse(plugin.context.spec);
    const owners = new Map<string, string>();
    const ids = new Set<string>();

    plugin.forEach('operation', ({ operation }) => {
      const { id, base: unsuffixed, fields } = operationParams(operation);
      if (ids.has(id)) throw new Error(`Duplicate operationId: ${id}`);
      ids.add(id);
      const parsedVersion = OperationVersionSchema.safeParse(operation['x-operation-version']);
      const version: OperationVersion | undefined = parsedVersion.data;
      const base = plugin.config.versionSuffix && version !== undefined ? `${unsuffixed}V${version}` : unsuffixed;
      rejectAmbiguousBody(operation, id, fields);
      rejectRepeatedNames(id, fields);
      rejectDisagreement(document, operation, id, fields);
      for (const name of [`${base}Params`, `${base}ParamsSchema`, `${base}Input`, `${base}Output`]) {
        const previous = owners.get(name);
        if (previous) throw new Error(`Name collision: ${name}\n  ${previous}\n  ${id}`);
        owners.set(name, id);
      }
      // Empty operations still receive an empty Params schema for CLI options.
      const schema = plugin.symbol(`${base}ParamsSchema`, {
        meta: {
          artifact: 'flat-params',
          category: 'schema',
          resource: 'operation',
          resourceId: operation.id,
          role: 'params',
          tags: fields.length ? ['has-params'] : []
        }
      });
      plugin.node(
        $.const(schema)
          .export()
          .assign(
            $(zodSymbol)
              .attr('object')
              .call(paramsMembers(plugin, operation, fields))
          )
      );
      const type = plugin.symbol(`${base}Params`);
      plugin.node(
        $.type
          .alias(type)
          .export()
          .type($.type(zodSymbol).attr('infer').generic($(schema).typeofType()))
      );
      const meta = { artifact: 'flat-params', category: 'type', resource: 'operation', resourceId: operation.id };
      // An operation without parameters has no Input: its call takes only options.
      if (fields.length) {
        const input = plugin.symbol(`${base}Input`, { meta: { ...meta, role: 'input' } });
        plugin.node($.type.alias(input).export().type(inputType(plugin, fields)));
      }
      const response = plugin.querySymbol({
        category: 'type',
        resource: 'operation',
        resourceId: operation.id,
        role: 'response'
      });
      const output = plugin.symbol(`${base}Output`, { meta: { ...meta, role: 'output' } });
      plugin.node(
        $.type
          .alias(output)
          .export()
          .type($.type(response ?? 'unknown'))
      );
    });
  }
});
