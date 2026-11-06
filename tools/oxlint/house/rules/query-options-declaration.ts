import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const OPTIONS_FUNCTIONS = new Set(["queryOptions", "infiniteQueryOptions"]);
const NAME = /^[a-z][A-Za-z0-9]*QueryOptions$/;

type Expression = ESTree.Expression;

/** The expression under any `as const` or `satisfies`. */
function unwrap(node: Expression): Expression {
  let current = node;
  while (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression") current = current.expression;
  return current;
}

/** The names a parameter binds: `id`, `{ id, streamId }`, `[first]`, `id = ''`. */
function boundNames(pattern: ESTree.Node, names: Set<string>): void {
  if (pattern.type === "Identifier") names.add(pattern.name);
  else if (pattern.type === "AssignmentPattern") boundNames(pattern.left, names);
  else if (pattern.type === "RestElement") boundNames(pattern.argument, names);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) element && boundNames(element, names);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) boundNames(property.type === "RestElement" ? property : property.value, names);
}

/**
 * The `const nameQueryOptions = (…) => queryOptions({…})` a call is the whole body of, at module level: the arrow
 * function, and the binding it is declared as. Undefined for a call anywhere else.
 */
function declaration(call: ESTree.CallExpression) {
  const fn = call.parent;
  if (fn?.type !== "ArrowFunctionExpression" || fn.body !== call) return undefined;
  const declarator = fn.parent;
  if (declarator?.type !== "VariableDeclarator" || declarator.init !== fn || declarator.id.type !== "Identifier") return undefined;
  const statement = declarator.parent;
  if (statement?.type !== "VariableDeclaration" || statement.kind !== "const") return undefined;
  const owner = statement.parent?.type === "ExportNamedDeclaration" ? statement.parent.parent : statement.parent;
  if (owner?.type !== "Program") return undefined;
  return { fn, binding: declarator.id };
}

/** A key segment written by convention: a literal, or one of the function's parameters (or a field of one). */
function isConventionalSegment(element: ESTree.Node | null, parameters: Set<string>): boolean {
  if (!element) return false;
  if (element.type === "Literal") return typeof element.value === "string" || typeof element.value === "number";
  if (element.type === "Identifier") return parameters.has(element.name);
  if (element.type === "MemberExpression" && !element.computed) return isConventionalSegment(element.object, parameters);
  return false;
}

function propertyOf(options: ESTree.ObjectExpression, name: string): ESTree.Property | undefined {
  return options.properties.find(
    (property): property is ESTree.Property =>
      property.type === "Property" && !property.computed && property.key.type === "Identifier" && property.key.name === name,
  );
}

/**
 * Every query is its own module-level `const nameQueryOptions = (…) => queryOptions({…})`, never a method of a factory
 * object, and its `queryKey` is a literal array written by convention (`['streams', organisationId, 'detail',
 * streamId]`): string segments and the function's own parameters, never spread from or built by another key's
 * function. A query written inline (an object with a `queryFn` anywhere else) is reported too.
 */
export const queryOptionsDeclarationRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Require each query to be a module-level `…QueryOptions` function with a conventional literal key." },
    schema: [],
    messages: {
      placement:
        "Declare each query as its own module-level `const nameQueryOptions = (…) => queryOptions({…})`, not inside an object, a hook or another function.",
      name: "Name the query `{{name}}` as `…QueryOptions`, such as `streamDetailQueryOptions`.",
      key: "Write `queryKey` as a literal array of string segments and this function's parameters, by convention (`['streams', organisationId, 'detail', streamId]`), not spread from or built by other keys.",
      keyStart: "Start `queryKey` with a string segment naming the resource, such as `'streams'`.",
      inline: "Declare this query as a module-level `…QueryOptions` function and call that, rather than writing its options inline.",
    },
  },
  createOnce(context) {
    // The local names `queryOptions` and `infiniteQueryOptions` are imported as.
    const optionsNames = new Set<string>();
    const checked = new WeakSet<ESTree.ObjectExpression>();
    return {
      before() {
        optionsNames.clear();
      },
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        if (node.source.value !== "@tanstack/react-query") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") continue;
          if (OPTIONS_FUNCTIONS.has(specifier.imported.name)) optionsNames.add(specifier.local.name);
        }
      },
      CallExpression(node: ESTree.CallExpression) {
        if (node.callee.type !== "Identifier" || !optionsNames.has(node.callee.name)) return;
        const options = node.arguments[0];
        if (options?.type === "ObjectExpression") checked.add(options);
        const declared = declaration(node);
        if (!declared) {
          context.report({ node, messageId: "placement" });
          return;
        }
        if (!NAME.test(declared.binding.name)) {
          context.report({ node: declared.binding, messageId: "name", data: { name: declared.binding.name } });
        }
        if (options?.type !== "ObjectExpression") return;
        const key = propertyOf(options, "queryKey");
        if (!key) return;
        const parameters = new Set<string>();
        for (const parameter of declared.fn.params) boundNames(parameter, parameters);
        const value = unwrap(key.value as Expression);
        if (value.type !== "ArrayExpression" || !value.elements.every(element => isConventionalSegment(element, parameters))) {
          context.report({ node: key, messageId: "key" });
          return;
        }
        const [first] = value.elements;
        if (first?.type !== "Literal" || typeof first.value !== "string") context.report({ node: key, messageId: "keyStart" });
      },
      // Runs after the call's own visit, so an options object passed to `queryOptions` is already marked. A query is
      // recognised by its `queryFn`: cache filters (`invalidateQueries({ queryKey })`) name a key but define nothing.
      "ObjectExpression:exit"(node: ESTree.ObjectExpression) {
        if (checked.has(node) || !propertyOf(node, "queryFn")) return;
        context.report({ node, messageId: "inline" });
      },
    };
  },
});
