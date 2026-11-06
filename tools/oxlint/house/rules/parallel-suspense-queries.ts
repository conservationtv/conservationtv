import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const SUSPENSE_HOOKS = new Set(["useSuspenseQuery", "useSuspenseQueries", "useSuspenseInfiniteQuery"]);

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

interface Declared {
  name: string;
  /** Where its declaration ends: after its initialiser, such as the query call it holds the result of. */
  end: number;
}

/** What one component or hook does: its suspense hook calls, and the names it declares, in source order. */
interface Body {
  calls: ESTree.CallExpression[];
  declared: Declared[];
}

function isFunction(node: ESTree.Node): node is FunctionNode {
  return node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
}

function owningFunction(node: ESTree.Node): FunctionNode | undefined {
  for (let current = node.parent; current; current = current.parent) if (isFunction(current)) return current;
  return undefined;
}

function boundNames(pattern: ESTree.Node, names: string[]): void {
  if (pattern.type === "Identifier") names.push(pattern.name);
  else if (pattern.type === "AssignmentPattern") boundNames(pattern.left, names);
  else if (pattern.type === "RestElement") boundNames(pattern.argument, names);
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements) element && boundNames(element, names);
  else if (pattern.type === "ObjectPattern") for (const property of pattern.properties) boundNames(property.type === "RestElement" ? property : property.value, names);
}

/** Every identifier read anywhere under a node. */
function referencedNames(node: ESTree.Node, names: Set<string>): void {
  if (node.type === "Identifier") names.add(node.name);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    // Non-computed property names (`a.b`, `{ b: … }`) are labels, not reads.
    if (key === "property" && node.type === "MemberExpression" && !node.computed) continue;
    if (key === "key" && node.type === "Property" && !node.computed && !node.shorthand) continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string") referencedNames(child, names);
    }
  }
}

/**
 * Suspense queries in one component or hook run one after another: each suspends before the next starts. Two that
 * don't depend on each other belong in one `useSuspenseQueries`, so they fetch in parallel. A later call depends on an
 * earlier one when its arguments read a name declared from the first call on, such as the earlier query's result, and
 * is left alone.
 */
export const parallelSuspenseQueriesRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Require independent suspense queries to be fetched together with `useSuspenseQueries`." },
    schema: [],
    messages: {
      sequential:
        "This query doesn't depend on the suspense query before it, so it waits for nothing: fetch them together with `useSuspenseQueries` so they run in parallel.",
    },
  },
  createOnce(context) {
    const bodies = new Map<FunctionNode, Body>();
    const bodyOf = (node: ESTree.Node) => {
      const fn = owningFunction(node);
      if (!fn) return undefined;
      const body = bodies.get(fn) ?? { calls: [], declared: [] };
      bodies.set(fn, body);
      return body;
    };
    return {
      before() {
        bodies.clear();
      },
      VariableDeclarator(node: ESTree.VariableDeclarator) {
        const names: string[] = [];
        boundNames(node.id, names);
        bodyOf(node)?.declared.push(...names.map(name => ({ name, end: node.end })));
      },
      CallExpression(node: ESTree.CallExpression) {
        if (node.callee.type !== "Identifier" || !SUSPENSE_HOOKS.has(node.callee.name)) return;
        bodyOf(node)?.calls.push(node);
      },
      "Program:exit"() {
        for (const { calls, declared } of bodies.values()) {
          const [first, ...later] = calls;
          if (!first) continue;
          // Names declared from the first query on (`const a = useSuspenseQuery(…)` included) only exist once it has
          // resolved: reading one makes a later call dependent.
          for (const call of later) {
            const resolved = new Set(
              declared.filter(entry => entry.end > first.start && entry.end <= call.start).map(entry => entry.name),
            );
            const reads = new Set<string>();
            for (const argument of call.arguments) referencedNames(argument, reads);
            if ([...reads].some(name => resolved.has(name))) continue;
            context.report({ node: call, messageId: "sequential" });
          }
        }
      },
    };
  },
});
