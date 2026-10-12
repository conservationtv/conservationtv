import { $, definePluginConfig, type DefinePlugin, type Plugin } from '@hey-api/openapi-ts';
import ts from 'typescript';
import { operationParams, paramsBase } from '@conservationtv/controlplane-sdk/codegen';
import { CURRENT, type Operations } from '@conservationtv/controlplane-sdk/codegen/operations';

interface IncurBuilderUserOptions {
  name: 'incur-builder';
  clientPackage?: string;
  operations?: Operations;
}
interface IncurBuilderOptions {
  name: 'incur-builder';
  clientPackage: string;
  operations: Operations;
}
type UserConfig = IncurBuilderUserOptions & Plugin.Hooks & Plugin.UserExports;
type Config = IncurBuilderOptions & Plugin.Hooks & Plugin.Exports;
type IncurBuilderPlugin = DefinePlugin<UserConfig, Config>;

/**
 * Companion to the supplied flat SDK config and Client; tested with Hey API 0.99.0 / Incur 0.6.1. A
 * versionless operation is a command; a versioned one is a command group with a `v1`, `v2`, ... command per version the
 * client keeps, which handshakes first so a version the server doesn't serve fails before it is sent.
 */
export const incurBuilder = definePluginConfig<IncurBuilderPlugin['Types']>({
  name: 'incur-builder',
  config: {
    includeInEntry: true,
    clientPackage: '@conservationtv/controlplane-sdk',
    operations: { order: [], versioned: [], versionless: [] }
  },
  handler({ plugin }) {
    const Cli = plugin.symbolFactory.register('Cli', { external: 'incur' });
    const z = plugin.symbolFactory.register('z', { external: 'zod' });
    const cliOptions = plugin.symbolFactory.register('cliOptions', { external: '../options.js' });
    const Client = plugin.symbolFactory.register('Client', {
      external: plugin.config.clientPackage,
      kind: 'type'
    });
    const source = plugin.symbol('CliClientSource');
    plugin.node(
      $.type
        .alias(source)
        .export()
        .type(
          $.type.or($.type(Client), $.type.func().returns($.type.or($.type(Client), $.type('Promise').generic(Client))))
        )
    );

    type Branch = { children: Map<string, Branch>; definition?: ReturnType<typeof $.object>; description?: string };
    const root: Branch = { children: new Map() };
    const branch = (id: string) => {
      const parts = id.split('.');
      // Keep CLI paths and generated SDK property names unambiguous.
      if (parts.some(part => !/^[a-z][a-zA-Z0-9]*$/.test(part))) {
        throw new Error(`Use dot-separated lowerCamelCase operationId segments: ${id}`);
      }
      let node = root;
      for (const part of parts) {
        if (node.definition) throw new Error(`Command is also a command group: ${id}`);
        let child = node.children.get(part);
        if (!child) node.children.set(part, (child = { children: new Map() }));
        node = child;
      }
      return node;
    };
    const define = (node: Branch, definition: ReturnType<typeof $.object>, id: string) => {
      if (node.definition || node.children.size) throw new Error(`Conflicting CLI command: ${id}`);
      node.definition = definition;
    };

    /** A command calling `client.<id>` (then `.<member>`, for a version) with the named Params schema as its options. */
    const command = (
      id: string,
      member: string | undefined,
      params: string,
      hasParams: boolean,
      description: string
    ) => {
      const schema = plugin.symbolFactory.register(params, { external: plugin.config.clientPackage });
      let method = $('client');
      for (const part of id.split('.')) method = $(method.attr(part));
      if (member) method = $(method.attr(member));
      const call = hasParams ? method.call($('options')) : method.call();
      const run = $.func().async();
      if (hasParams) run.param(p => p.object('options'));
      run.do(
        $.const('client').assign($.await($('resolveClient').call())),
        ...(member ? [$.stmt($.await($('client').attr('handshake').call()))] : []),
        $.const('result').assign($.await(call)),
        $.if($.binary($('result'), ts.SyntaxKind.InstanceOfKeyword, $('Error'))).do($.throw($('result'), false)),
        $.return($('result'))
      );
      return $.object()
        .pretty()
        .prop('description', $.literal(description))
        .prop('options', $(cliOptions).call($(schema)))
        .prop('run', run);
    };

    const versioned = Map.groupBy(plugin.config.operations.versioned, operation => operation.operationId);

    plugin.forEach('operation', ({ operation }) => {
      const id = operation.operationId;
      if (!id) throw new Error(`Missing operationId: ${operation.id}`);
      // Versioned groups are created here, so they keep their place among the commands, and filled below.
      if (versioned.has(id)) {
        branch(id);
        return;
      }
      const { base, fields } = operationParams(operation);
      const description = [...new Set([operation.summary, operation.description].filter(Boolean))].join('\n\n');
      define(branch(id), command(id, undefined, `${base}ParamsSchema`, fields.length > 0, description), id);
    });

    for (const [id, versions] of versioned) {
      const group = branch(id);
      if (group.definition) throw new Error(`Conflicting CLI command: ${id}`);
      const sorted = versions.toSorted((a, b) => a.version - b.version);
      group.description = sorted.at(-1)!.description;
      for (const { version, source, hasParams, description } of sorted) {
        // Each frozen operation contract has version-suffixed Params; plain current SDK Params stay separate.
        const params = `${paramsBase(id)}${source === CURRENT ? '' : `V${version}`}ParamsSchema`;
        define(
          branch(`${id}.v${version}`),
          command(id, `v${version}`, params, hasParams, description),
          `${id} v${version}`
        );
      }
    }

    function mount(parent: ReturnType<typeof $>, branch: Branch): ReturnType<typeof $> {
      let result = parent;
      for (const [name, child] of branch.children) {
        result = child.definition
          ? $(result.attr('command').call($.literal(name), child.definition))
          : $(
              result.attr('command').call(
                mount(
                  $(
                    $(Cli)
                      .attr('create')
                      .call(
                        ...(child.description
                          ? [$.literal(name), $.object().prop('description', $.literal(child.description))]
                          : [$.literal(name)])
                      )
                  ),
                  child
                )
              )
            );
      }
      return result;
    }

    const schemaOrUndefined = () => $.type.or($.type(z).attr('ZodObject').generic('any'), 'undefined');
    const builder = $.func(plugin.symbol('buildCli'))
      .export()
      .generic('Commands', g => g.extends($.type(Cli).attr('CommandsMap')))
      .generic('Vars', g => g.extends(schemaOrUndefined()))
      .generic('Env', g => g.extends(schemaOrUndefined()))
      .generic('Globals', g => g.extends(schemaOrUndefined()))
      .generic('Name', g => g.extends('string'))
      .param('cli', p =>
        p.type(
          $.type(Cli).attr('Cli').generic('Commands').generic('Vars').generic('Env').generic('Globals').generic('Name')
        )
      )
      .param('clientSource', p => p.type(source))
      .do(
        $.const('resolveClient').assign(
          $.func()
            .async()
            .do(
              $.if($.binary($.typeofExpr($('clientSource')), '===', $.literal('function'))).do(
                $.return($('clientSource').call())
              ),
              $.return($('clientSource'))
            )
        ),
        $.return(mount($('cli'), root))
      );
    plugin.node(builder);
  }
});
