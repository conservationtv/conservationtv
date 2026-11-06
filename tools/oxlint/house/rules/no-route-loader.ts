import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const LOADERS = new Set(["clientLoader", "loader"]);

/** The names an `export` declares: `export function clientLoader`, `export const loader = …`. */
function exportedNames(node: ESTree.ExportNamedDeclaration): ESTree.Node[] {
  const declaration = node.declaration;
  if (declaration?.type === "FunctionDeclaration" && declaration.id) return [declaration.id];
  if (declaration?.type === "VariableDeclaration") return declaration.declarations.map(declarator => declarator.id);
  return node.specifiers.map(specifier => specifier.exported);
}

/**
 * Pages read their data at render, with `useSuspenseQuery` under a Suspense boundary, and their IDs from the `params`
 * prop React Router types for them (`FC<Route.ComponentProps>`), so a route module exports no `clientLoader` or
 * `loader`. One that needs one anyway is an exception to be approved.
 */
export const noRouteLoaderRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow route loaders: pages read data at render with suspense queries." },
    schema: [],
    messages: {
      loader:
        "Don't export a `{{name}}`: read data at render with `useSuspenseQuery`/`useSuspenseQueries` under a Suspense boundary, route IDs from the component's `params` prop, and redirect by rendering `<Navigate>`. A loader is an exception that needs explicit approval.",
    },
  },
  createOnce(context) {
    return {
      ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
        for (const name of exportedNames(node)) {
          if (name.type !== "Identifier" || !LOADERS.has(name.name)) continue;
          context.report({ node: name, messageId: "loader", data: { name: name.name } });
        }
      },
    };
  },
});
