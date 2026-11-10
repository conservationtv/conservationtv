import { $, definePluginConfig, type DefinePlugin, type Plugin } from '@hey-api/openapi-ts';
import { operationIdOf, paramsBase } from './operation-params.js';
import { CURRENT, type Operations, type OperationVersion, type SpecEntry } from './operation-versions.js';

interface SdkClientOptions {
  name: 'sdk-client';
  operations: Operations;
  /** Where the generated Client imports its runtime (`ClientCore`, `operation`) from. */
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
  versionless?: SpecEntry;
}

/**
 * Generates Client: the operations as a tree, each a descriptor of its method, URL and fields, typed by the Input and
 * Output `flatParams` writes for its contract (this job's for `current`, `../versions/<operationId>-vN` otherwise). A
 * versioned operation maps its versions to their descriptors; a versionless one is its call, or for a WebSocket the
 * address it would be sent to. The generated fetch client (`createClient`, `mergeHeaders`, `buildClientParams`) is
 * handed to the runtime as the `http` field. Runs in the job for the current spec; tested with Hey API 0.99.0.
 */
export const sdkClient = definePluginConfig<SdkClientPlugin['Types']>({
  name: 'sdk-client',
  config: {
    includeInEntry: true,
    operations: { order: [], versioned: [], versionless: [] },
    runtimeModule: '@conservationtv/versioned-api/client'
  },
  dependencies: ['flat-params'],
  handler({ plugin }) {
    const core = plugin.symbolFactory.register('ClientCore', { external: plugin.config.runtimeModule });
    const describe = plugin.symbolFactory.register('operation', { external: plugin.config.runtimeModule });
    const createClient = plugin.symbolFactory.register('createClient', { external: './client/index.js' });
    const mergeHeaders = plugin.symbolFactory.register('mergeHeaders', { external: './client/index.js' });
    const buildClientParams = plugin.symbolFactory.register('buildClientParams', { external: './client/index.js' });

    // This job's operations by operationId, as its own `flatParams` names their types.
    const parsed = new Map<string, string>();
    plugin.forEach('operation', ({ operation }) => {
      const operationId = operationIdOf(operation);
      if (operationId) parsed.set(operationId, operation.id);
    });
    /** An operation's Input or Output: this job's for the current spec, its contract folder's otherwise. */
    const typeOf = (entry: SpecEntry, role: 'input' | 'output') => {
      if (entry.source !== CURRENT) {
        const name = `${paramsBase(entry.operationId)}V${entry.version}${role === 'input' ? 'Input' : 'Output'}`;
        return plugin.symbolFactory.register(name, {
          external: `../versions/${entry.source}/flat-params.gen.js`,
          kind: 'type'
        });
      }
      const symbol = plugin.querySymbol({
        artifact: 'flat-params',
        category: 'type',
        resource: 'operation',
        resourceId: parsed.get(entry.operationId),
        role
      });
      if (!symbol) throw new Error(`sdk-client requires flat-params' ${role} type: ${entry.operationId}`);
      return symbol;
    };
    /** `operation<Output, Input>({ method, url, fields })`, without Input or fields when a call takes no parameters. */
    const descriptor = (entry: SpecEntry) => {
      const described = $.object().prop('method', $.literal(entry.method)).prop('url', $.literal(entry.path));
      const call = $(describe).call(described).generic(typeOf(entry, 'output'));
      if (!entry.fields.length) return call;
      described.prop('fields', $.fromValue(entry.fields));
      return call.generic(typeOf(entry, 'input'));
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
    for (const operation of plugin.config.operations.versionless) leaf(operation.operationId).versionless = operation;

    const operationCall = (operationId: string, versions: OperationVersion[]) => {
      const sdks = $.object();
      for (const operation of versions.toSorted((a, b) => a.version - b.version)) {
        sdks.prop(`v${operation.version}`, descriptor(operation));
      }
      return $('this').attr('versioned').call($.literal(operationId), sdks);
    };
    const versionlessCall = (operation: SpecEntry) =>
      $('this')
        .attr(operation.webSocket ? 'webSocket' : 'versionless')
        .call(descriptor(operation));
    type Expression =
      | ReturnType<typeof $.object>
      | ReturnType<typeof operationCall>
      | ReturnType<typeof versionlessCall>;
    const toExpression = (operationId: string, branch: Branch): Expression => {
      // A leaf is an operation (versioned or not); anything else is a namespace object of its children.
      if (branch.versions || branch.versionless) {
        if (branch.children.size) throw new Error(`operationId is also a namespace: ${operationId}`);
        return branch.versions ? operationCall(operationId, branch.versions) : versionlessCall(branch.versionless!);
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
      field
        .readonly()
        .assign(
          $.object()
            .prop('createClient', $(createClient))
            .prop('mergeHeaders', $(mergeHeaders))
            .prop('buildClientParams', $(buildClientParams))
        )
    );
    for (const [part, child] of root.children) {
      declaration.field(part, field => field.readonly().assign(toExpression(part, child)));
    }
    plugin.node(declaration);
  }
});
