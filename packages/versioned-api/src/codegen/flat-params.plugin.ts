import { $, definePluginConfig, type DefinePlugin, type IR, type Plugin } from '@hey-api/openapi-ts';
import { z } from 'zod';
import { operationParams, type ParamField } from './operation-params.js';

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
 * 0.99.0 does not consistently disambiguate a scalar/array body's fallback 'body' key from a parameter also named
 * 'body'. Reject it rather than emit Params that send the wrong value.
 */
function rejectAmbiguousBody(operation: IR.OperationObject, fields: ParamField[], locations: Map<string, Set<string>>) {
  const wholeBody = operation.body && !operation.body.schema.$ref && fields.some(field => field.whole);
  if (wholeBody && (locations.get('body')?.size ?? 0) > 1) {
    throw new Error(`Unsupported conflicting body parameter: ${operation.operationId}`);
  }
}

/** The member expression for one field: the generated request-layer schema (or one of its members), described. */
function memberExpression(plugin: FlatParamsInstance, operation: IR.OperationObject, field: ParamField) {
  const layer = field.location === 'header' ? 'headers' : field.location;
  const symbol = plugin.querySymbol({
    artifact: 'zod',
    category: 'schema',
    resource: 'operation',
    resourceId: operation.id,
    role: `request-${layer}`
  });
  if (!symbol) throw new Error(`Missing Zod ${layer} schema: ${operation.operationId}`);
  const expression = field.whole ? $(symbol) : $(symbol).attr('shape').attr(field.key);
  const validated = expression.attr(field.required ? 'nonoptional' : 'optional').call();
  return field.description ? $(validated).attr('describe').call($.literal(field.description)) : validated;
}

/** One flat Zod object member per field. Only names that repeat across locations get a location prefix. */
function paramsMembers(plugin: FlatParamsInstance, operation: IR.OperationObject, fields: ParamField[]) {
  const members = $.object().pretty();
  const locations = locationsByKey(fields);
  rejectAmbiguousBody(operation, fields, locations);
  const emitted = new Set<string>();
  for (const field of fields) {
    // Location-prefix only names repeated across locations; any remaining clash is an error, not a silent overwrite.
    const name = (locations.get(field.key)?.size ?? 0) > 1 ? `${field.location}_${field.key}` : field.key;
    if (emitted.has(name)) throw new Error(`Ambiguous flat field ${name}: ${operation.operationId}`);
    emitted.add(name);
    members.prop(name, memberExpression(plugin, operation, field));
  }
  return members;
}

/** Matches @hey-api/sdk 0.99.0's flat signatures. Pin that version. */
export const flatParams = definePluginConfig<FlatParamsPlugin['Types']>({
  name: 'flat-params',
  // With `versionSuffix`, a versioned operation's names include its version (`GrantExchangeV1Params`), so the Params
  // of several spec snapshots can be exported side by side.
  config: { includeInEntry: true, versionSuffix: false },
  dependencies: ['zod', '@hey-api/sdk'],
  handler({ plugin }) {
    const zodSymbol = plugin.symbolFactory.register('z', { external: 'zod' });
    const owners = new Map<string, string>();
    const ids = new Set<string>();

    plugin.forEach('operation', ({ operation }) => {
      const id = operation.operationId;
      if (!id) throw new Error(`Missing operationId: ${operation.id}`);
      if (ids.has(id)) throw new Error(`Duplicate operationId: ${id}`);
      ids.add(id);
      const { base: unsuffixed, fields } = operationParams(operation);
      const parsedVersion = OperationVersionSchema.safeParse(operation['x-operation-version']);
      const version: OperationVersion | undefined = parsedVersion.data;
      const base = plugin.config.versionSuffix && version !== undefined ? `${unsuffixed}V${version}` : unsuffixed;
      for (const name of [`${base}Params`, `${base}ParamsSchema`]) {
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
    });
  }
});
