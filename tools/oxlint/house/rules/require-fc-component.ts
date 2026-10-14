import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const COMPONENT_TYPES = new Set(["FC", "FunctionComponent"]);

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

function isFunction(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** `FC`, `FC<Props>`, `React.FC<Props>`, `FunctionComponent<Props>` or `React.FunctionComponent<Props>`. */
function isComponentType(annotation: ESTree.TSTypeAnnotation | null | undefined): boolean {
  const type = annotation?.typeAnnotation;
  if (type?.type !== "TSTypeReference") return false;
  const name = type.typeName;
  if (name.type === "Identifier") return COMPONENT_TYPES.has(name.name);
  return name.type === "TSQualifiedName" && COMPONENT_TYPES.has(name.right.name);
}

/** The PascalCase binding a function is declared as, if any: `function Name` or `const Name = () => …`. */
function componentBinding(fn: FunctionNode): ESTree.BindingIdentifier | undefined {
  if (fn.type === "FunctionDeclaration") return fn.id && PASCAL_CASE.test(fn.id.name) ? fn.id : undefined;
  const parent = fn.parent;
  if (parent?.type !== "VariableDeclarator" || parent.init !== fn || parent.id.type !== "Identifier") return undefined;
  return PASCAL_CASE.test(parent.id.name) ? parent.id : undefined;
}

/**
 * The component a piece of JSX belongs to: the nearest enclosing function with a PascalCase name. Unnamed callbacks
 * in between (a `.map(…)` inside a component) are skipped, so their JSX counts towards the component around them.
 */
function owningComponent(node: ESTree.Node): FunctionNode | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunction(current) && componentBinding(current)) return current;
  }
  return undefined;
}

/**
 * Require React components to be written as `const Name: FC<Props> = (…) => …`. A component is a function with a
 * PascalCase name that renders JSX; `function Name(…)` declarations (including exported and default-exported ones)
 * and `const Name = …` without an `FC` annotation are reported.
 */
export const requireFcComponentRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Require React components to be declared as `const Name: FC<Props> = (…) => …`.",
    },
    schema: [],
    messages: {
      functionDeclaration:
        "Declare the component `{{name}}` as `const {{name}}: FC<Props> = (…) => …` rather than a function declaration.",
      missingFcType: "Annotate the component `{{name}}` with its type: `const {{name}}: FC<Props> = (…) => …`.",
    },
  },
  createOnce(context) {
    // Each component is reported once, however much JSX it renders.
    const reported = new WeakSet<FunctionNode>();
    function check(jsx: ESTree.Node): void {
      const component = owningComponent(jsx);
      if (!component || reported.has(component)) return;
      reported.add(component);
      const binding = componentBinding(component)!;
      if (component.type === "FunctionDeclaration") {
        context.report({ node: binding, messageId: "functionDeclaration", data: { name: binding.name } });
      } else if (!isComponentType(binding.typeAnnotation)) {
        context.report({ node: binding, messageId: "missingFcType", data: { name: binding.name } });
      }
    }
    return {
      JSXElement: check,
      JSXFragment: check,
    };
  },
});
