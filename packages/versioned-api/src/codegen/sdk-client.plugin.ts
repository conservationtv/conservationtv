import { $, definePluginConfig, type DefinePlugin, type Plugin } from '@hey-api/openapi-ts';
import { CURRENT, type Operations, type OperationVersion } from './operation-versions.js';

interface SdkClientOptions {
  name: 'sdk-client';
  operations: Operations;
  /** Where the generated Client imports its runtime (`ClientCore`) from. */
  runtimeModule: string;
}
interface SdkClientUserOptions {
  name: 'sdk-client';
  operations: Operations;
  runtimeModule?: string;
}
type UserConfig = SdkClientUserOptions & Plugin.Hooks & Plugin.UserExports;
type Config = SdkClientOptions & Plugin.Hooks & Plugin.Exports;
type SdkClientPlugin = DefinePlugin<UserConfig, Config>;

interface Branch {
  children: Map<string, Branch>;
  versions?: OperationVersion[];
  versionless?: boolean;
}

/**
 * Generates Client: the supplied BaseClient's operation tree. A versioned operation maps its versions to the
 * BaseClient generated from the spec that defines it (this job's for `current`, `../versions/<operationId>-vN` otherwise); a
 * versionless one is this job's BaseClient method. The generated fetch client (`createClient`, `mergeHeaders`) is
 * handed to the runtime as the `http` field. Runs in the job for the current spec; tested with Hey API 0.99.0.
 */
export const sdkClient = definePluginConfig<SdkClientPlugin['Types']>({
  name: 'sdk-client',
  config: {
    includeInEntry: true,
    operations: { order: [], versioned: [], versionless: [] },
    runtimeModule: '@conservationtv/versioned-api/client'
  },
  dependencies: ['@hey-api/sdk'],
  handler({ plugin }) {
    const base = plugin.querySymbol({
      artifact: 'sdk',
      category: 'utility',
      resource: 'class',
      resourceId: 'BaseClient'
    });
    if (!base) throw new Error('sdk-client requires the supplied instance BaseClient SDK config.');
    const core = plugin.symbolFactory.register('ClientCore', { external: plugin.config.runtimeModule });
    const createClient = plugin.symbolFactory.register('createClient', { external: './client/index.js' });
    const mergeHeaders = plugin.symbolFactory.register('mergeHeaders', { external: './client/index.js' });
    const sources = new Map([[CURRENT, base]]);
    const sdkFor = (source: string) => {
      let symbol = sources.get(source);
      if (!symbol) {
        symbol = plugin.symbolFactory.register('BaseClient', { external: `../versions/${source}/sdk.gen.js` });
        sources.set(source, symbol);
      }
      return symbol;
    };

    const root: Branch = { children: new Map() };
    const leaf = (operationId: string) => {
      let node = root;
      for (const part of operationId.split('.')) {
        let child = node.children.get(part);
        if (!child) {
          child = { children: new Map() };
          node.children.set(part, child);
        }
        node = child;
      }
      return node;
    };
    // Create the current spec's operations first, so members follow its order.
    for (const operationId of plugin.config.operations.order) leaf(operationId);
    for (const operation of plugin.config.operations.versioned) {
      const branch = leaf(operation.operationId);
      if (branch.versions == null) branch.versions = [];
      branch.versions.push(operation);
    }
    for (const operation of plugin.config.operations.versionless) leaf(operation.operationId).versionless = true;

    const operationCall = (operationId: string, versions: OperationVersion[]) => {
      const sdks = $.object();
      for (const operation of versions.toSorted((a, b) => a.version - b.version)) {
        sdks.prop(`v${operation.version}`, $(sdkFor(operation.source)));
      }
      return $('this').attr('versioned').call($.literal(operationId), sdks);
    };
    const versionlessCall = (operationId: string) =>
      $('this').attr('versionless').call($.literal(operationId), $(base));
    type Expression =
      | ReturnType<typeof $.object>
      | ReturnType<typeof operationCall>
      | ReturnType<typeof versionlessCall>;
    const toExpression = (operationId: string, branch: Branch): Expression => {
      // A leaf is an operation (versioned or not); anything else is a namespace object of its children.
      if (branch.versions || branch.versionless) {
        if (branch.children.size) throw new Error(`operationId is also a namespace: ${operationId}`);
        return branch.versions ? operationCall(operationId, branch.versions) : versionlessCall(operationId);
      }
      const object = $.object().pretty();
      for (const [part, child] of branch.children) object.prop(part, toExpression(`${operationId}.${part}`, child));
      return object;
    };

    const client = plugin.symbol('Client', {
      meta: { artifact: 'sdk-client', category: 'utility', resource: 'class', resourceId: 'Client' }
    });
    const declaration = $.class(client)
      .export()
      .extends(core)
      .doc(
        'The SDK for servers running any release since the oldest supported snapshot. Call `handshake()` before versioned operations.'
      );
    declaration.field('http', field =>
      field.readonly().assign($.object().prop('createClient', $(createClient)).prop('mergeHeaders', $(mergeHeaders)))
    );
    for (const [part, child] of root.children) {
      declaration.field(part, field => field.readonly().assign(toExpression(part, child)));
    }
    plugin.node(declaration);
  }
});
