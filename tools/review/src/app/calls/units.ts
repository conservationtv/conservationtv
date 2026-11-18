import { parse } from '@babel/parser';
import type {
  CallExpression,
  ClassBody,
  Expression,
  ExportNamedDeclaration,
  ImportDeclaration,
  Node,
  ObjectExpression,
  Statement
} from '@babel/types';

// A source file as the functions it defines and the calls each makes, read from its syntax alone: what a reviewer
// follows by eye, without the type checker.

/** A call made inside a unit: what is called, as written, and with what, and the lines it spans. */
export interface Call {
  /** `ScheduleCheck.validate`, `this.check` or `run`: dotted names only; null when the callee is an expression. */
  callee: string | null;
  /** The callee as written, for showing: `CodeMode.make(...).execute`. */
  text: string;
  args: string;
  line: number;
  end: number;
}

/** A function or method; a value built from calls, such as a schema; or a route a router chain declares. */
export type UnitKind = 'function' | 'value' | 'route';

/** A named piece of a file: a function, a class or object method, a top-level value built from calls, or a route. */
export interface Unit {
  kind: UnitKind;
  /** `Schedule.create`, `ScheduleCheck.validate`, `fire`. */
  name: string;
  /** The class or object a method belongs to: `this.x` in it is `${owner}.x`. */
  owner: string | null;
  params: string;
  start: number;
  end: number;
  /** Its source, for telling whether it changed and for its diff. */
  text: string;
  calls: Call[];
  /** Every name it uses as a value, called or not: `createCn`, `customTextSizes`. */
  uses: string[];
}

/**
 * A top-level statement and the names it binds: `import { createCn } from "cn/config"` binds `createCn`, `export { cn }
 * from "cn"` binds `cn`. What a unit's name was bound to before it was a unit, and what else a unit is built from.
 */
export interface Binding {
  names: string[];
  start: number;
  end: number;
  text: string;
  /** The names its own code uses, to follow what it is built from in turn. */
  uses: string[];
  /** For an import, what each name is, `cn/config#createCn`: compared in place of the statement, which binds others. */
  imports: Record<string, string> | null;
}

/** A file's units, and its top-level statements by the names they bind. */
export interface FileUnits {
  units: Unit[];
  bindings: Binding[];
}

/** One line, at most `limit` characters: arguments and parameters as a reader skims them. */
function squash(text: string, limit = 60): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Fields of a node that are not its children. */
const NOT_CHILDREN: ReadonlySet<string> = new Set([
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra'
]);

/** Anything a node's field holds, looked at only for whether it is a node. */
interface MaybeNode {
  type?: string;
}

/** A syntax node: an object with a `type`. */
function isNode(value: MaybeNode | null): value is Node {
  return value !== null && 'type' in value;
}

/** A node with the node it is in, and the field of that node it is under. */
interface Placed {
  node: Node;
  parent: Node | null;
  key: string | null;
}

/** Every node within `node` with what it is in, depth first, `node` itself first. */
function* walk(node: Node, parent: Node | null = null, key: string | null = null): Generator<Placed> {
  yield { node, parent, key };
  for (const [field, value] of Object.entries(node)) {
    if (NOT_CHILDREN.has(field)) continue;
    // A child is a node or a list of them; everything else on a node is a plain value.
    const children: (MaybeNode | null)[] = Array.isArray(value) ? value : [value];
    for (const child of children) if (child instanceof Object && isNode(child)) yield* walk(child, node, field);
  }
}

/** Fields whose identifier names something rather than reading it: a binding, a label, an import or export. */
const NAMING_FIELDS: ReadonlySet<string> = new Set(['id', 'params', 'label', 'local', 'imported', 'exported']);

/** TypeScript wrappers around an expression, whose identifier is still read; every other `TS…` node is a type. */
const EXPRESSION_WRAPPERS: ReadonlySet<string> = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression'
]);

/** Whether what is under `key` of `parent` is the name of a property or key: `x` in `a.x` and `{ x: 1 }`. */
function isPropertyName(parent: Node, key: string): boolean {
  if (key === 'property') {
    return (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && !parent.computed;
  }
  return key === 'key' && 'computed' in parent && !parent.computed;
}

/** Whether an identifier uses a name as a value, called or not: not a binding, a key, a property name or a type. */
function isUse({ parent, key }: Placed): boolean {
  if (parent === null || key === null) return true;
  // A name bound, or a property's; then within a type, a name is a type's unless an expression is wrapped in it.
  if (NAMING_FIELDS.has(key) || isPropertyName(parent, key)) return false;
  return !parent.type.startsWith('TS') || EXPRESSION_WRAPPERS.has(parent.type);
}

/** The names a pattern binds: `a`, `b` and `c` in `{ a, b: [b], ...c }`, `x` in `x = 1`. */
function patternNames(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap(property =>
      patternNames(property.type === 'RestElement' ? property : property.value)
    );
  }
  if (node.type === 'ArrayPattern') return node.elements.flatMap(element => patternNames(element));
  if (node.type === 'AssignmentPattern') return patternNames(node.left);
  if (node.type === 'RestElement') return patternNames(node.argument);
  if (node.type === 'TSParameterProperty') return patternNames(node.parameter);
  return [];
}

/** The patterns a node binds names with: a variable's, a catch clause's error, a function's parameters. */
function bindingPatterns(node: Node): (Node | null | undefined)[] {
  if (node.type === 'VariableDeclarator') return [node.id];
  if (node.type === 'CatchClause') return [node.param];
  return 'params' in node ? node.params : [];
}

/** The names bound inside a node: its variables, the parameters of its functions, and its catch clauses' errors. */
function localNames(node: Node): Set<string> {
  return new Set([...walk(node)].flatMap(({ node: inner }) => bindingPatterns(inner).flatMap(patternNames)));
}

/** The names a node reads as values, other than those bound inside it. */
function readsIn(node: Node): string[] {
  const locals = localNames(node);
  const reads = [...walk(node)].flatMap(placed =>
    placed.node.type === 'Identifier' && isUse(placed) ? [placed.node.name] : []
  );
  return reads.filter(name => !locals.has(name));
}

/** The methods a router declares a route with. */
const ROUTE_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

/** `PUT /` for `.put('/', ...)`: a route's method is a plain name and its path a string as written. */
function routeName(link: CallExpression): string | null {
  if (link.callee.type !== 'MemberExpression' || link.callee.property.type !== 'Identifier') return null;
  const method = link.callee.property.name;
  const [path] = link.arguments;
  return ROUTE_METHODS.has(method) && path?.type === 'StringLiteral' ? `${method.toUpperCase()} ${path.value}` : null;
}

/** Declarations binding the one name they are given. */
const NAMED_DECLARATIONS: ReadonlySet<string> = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration'
]);

/** The names an export binds: what it declares, else the names it exports, `cn` for `export { cn } from "cn"`. */
function exportedNames(node: ExportNamedDeclaration): string[] {
  if (node.declaration) return boundNames(node.declaration);
  return node.specifiers.map(specifier =>
    specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
  );
}

/** The names a top-level statement binds. */
function boundNames(node: Statement | Expression): string[] {
  // Imports by their local names, exports by what they declare or export, variables by their plain names.
  if (node.type === 'ImportDeclaration') return node.specifiers.map(specifier => specifier.local.name);
  if (node.type === 'ExportNamedDeclaration') return exportedNames(node);
  if (node.type === 'ExportDefaultDeclaration') return ['default'];
  if (node.type === 'VariableDeclaration') {
    return node.declarations.flatMap(declarator => (declarator.id.type === 'Identifier' ? [declarator.id.name] : []));
  }
  const id = NAMED_DECLARATIONS.has(node.type) && 'id' in node ? node.id : null;
  return id?.type === 'Identifier' ? [id.name] : [];
}

/** What each name an import binds is: `cn/config#createCn`, `react#default`, `./x#*`. */
function importedNames(node: ImportDeclaration): Record<string, string> {
  const source = node.source.value;
  return Object.fromEntries(
    node.specifiers.map(specifier => {
      if (specifier.type === 'ImportDefaultSpecifier') return [specifier.local.name, `${source}#default`];
      if (specifier.type === 'ImportNamespaceSpecifier') return [specifier.local.name, `${source}#*`];
      const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
      return [specifier.local.name, `${source}#${imported}`];
    })
  );
}

class Reader {
  readonly units: Unit[] = [];
  readonly bindings: Binding[] = [];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  slice(node: Node): string {
    return this.source.slice(node.start ?? 0, node.end ?? 0);
  }

  /** From the start of the line `from` begins on to the end of `to`: a unit's text with its first line indented. */
  lines(from: number, to: number): string {
    return this.source.slice(this.source.lastIndexOf('\n', from - 1) + 1, to);
  }

  /** `a.b.c`, `this.x`; null for anything computed or called along the way. */
  dotted(node: Node): string | null {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'ThisExpression') return 'this';
    if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier') return null;
    const object = this.dotted(node.object);
    return object === null ? null : `${object}.${node.property.name}`;
  }

  /** The callee as shown: calls along the chain have their arguments elided. */
  shown(node: Node): string {
    if (node.type === 'CallExpression') return `${this.shown(node.callee)}(...)`;
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
      return `${this.shown(node.object)}.${node.property.name}`;
    }
    return squash(this.slice(node), 40);
  }

  call(node: CallExpression): Call {
    // Where it is: the lines from its callee to its closing parenthesis, 0 where the parser gives none.
    return {
      callee: this.dotted(node.callee),
      text: this.shown(node.callee),
      args: squash(node.arguments.map(arg => this.slice(arg)).join(', ')),
      line: node.loc?.start.line ?? 0,
      end: node.loc?.end.line ?? 0
    };
  }

  /** Every call inside a node, nested functions and callbacks included, in source order. */
  callsIn(node: Node): Call[] {
    const calls: Call[] = [];
    for (const { node: inner } of walk(node)) if (inner.type === 'CallExpression') calls.push(this.call(inner));
    return calls.toSorted((a, b) => a.line - b.line);
  }

  /**
   * The names used as values inside nodes, each once, other than those bound inside them: a local read is not the
   * top-level name it shadows, at the cost of a top-level one read where an inner scope does not shadow it.
   */
  usesIn(...nodes: Node[]): string[] {
    return [...new Set(nodes.flatMap(readsIn))];
  }

  /** A unit spanning `node`, with the calls inside it. */
  add(name: string, owner: string | null, node: Node, params: string, kind: UnitKind = 'function'): void {
    this.units.push({
      kind,
      name,
      owner,
      params: squash(params),
      start: node.loc?.start.line ?? 0,
      end: node.loc?.end.line ?? 0,
      text: this.lines(node.start ?? 0, node.end ?? 0),
      calls: this.callsIn(node),
      uses: this.usesIn(node)
    });
  }

  /** A function's parameters as written: `(session, check)`. */
  params(node: Node): string {
    const list = 'params' in node && Array.isArray(node.params) ? node.params : [];
    return list.map(param => this.slice(param)).join(', ');
  }

  /** An object literal's methods as `name.key`, and objects within it as `name.key.inner`. */
  object(name: string, node: ObjectExpression): void {
    for (const property of node.properties) {
      // Spreads and computed keys have no name to give.
      if (property.type === 'SpreadElement' || property.computed || property.key.type !== 'Identifier') continue;
      const key = `${name}.${property.key.name}`;
      if (property.type === 'ObjectMethod') this.add(key, name, property, this.params(property));
      else this.value(key, name, property.value);
    }
  }

  /** What a name is bound to: a function, an object of methods, or a value made with calls. */
  value(name: string, owner: string | null, node: Node): void {
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      this.add(name, owner, node, this.params(node));
    } else if (node.type === 'ObjectExpression') {
      this.object(name, node);
    } else if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') {
      this.value(name, owner, node.expression);
    } else if (!this.routes(node) && this.callsIn(node).length) {
      this.add(name, owner, node, '', 'value');
    }
  }

  /**
   * A router chain's routes, `new Hono().get('/a', ...).put('/b', ...)`, each a unit of its own named `GET /a`: its
   * handlers' calls are the route's. False when the chain declares none.
   */
  routes(node: Node): boolean {
    let found = false;
    let link: Node = node;
    // Down the chain from its last call to its first.
    while (link.type === 'CallExpression' && link.callee.type === 'MemberExpression') {
      found = this.route(link) || found;
      link = link.callee.object;
    }
    return found;
  }

  /** One link of a router chain as a route, when it is `.method('/path', ...handlers)`. */
  route(link: CallExpression): boolean {
    const name = routeName(link);
    if (name === null || link.callee.type !== 'MemberExpression') return false;
    const { property } = link.callee;
    const [, ...handlers] = link.arguments;
    this.units.push({
      kind: 'route',
      name,
      owner: null,
      params: '',
      start: property.loc?.start.line ?? 0,
      end: link.loc?.end.line ?? 0,
      text: this.lines(property.start ?? 0, link.end ?? 0),
      calls: handlers.flatMap(handler => this.callsIn(handler)),
      uses: this.usesIn(...handlers)
    });
    return true;
  }

  /** A class's methods, and its properties bound to functions or values, as `Class.member`. */
  klass(name: string, body: ClassBody): void {
    for (const member of body.body) {
      // Members named by a plain identifier only; a property with no value has nothing to read.
      if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
        const method = member.kind === 'constructor' ? 'constructor' : member.key.name;
        this.add(`${name}.${method}`, name, member, this.params(member));
      } else if (member.type === 'ClassProperty' && member.key.type === 'Identifier' && member.value) {
        this.value(`${name}.${member.key.name}`, name, member.value);
      }
    }
  }

  /** A top-level statement as what it binds. */
  binding(node: Statement): void {
    const names = boundNames(node);
    if (!names.length) return;
    this.bindings.push({
      names,
      start: node.loc?.start.line ?? 0,
      end: node.loc?.end.line ?? 0,
      text: this.lines(node.start ?? 0, node.end ?? 0),
      uses: node.type === 'ImportDeclaration' ? [] : this.usesIn(node),
      imports: node.type === 'ImportDeclaration' ? importedNames(node) : null
    });
  }

  /** A top-level statement's units: exports are read as what they export, a default expression as `default`. */
  statement(node: Statement | Expression): void {
    if (node.type === 'ExportDefaultDeclaration') {
      if (node.declaration.type.endsWith('Declaration')) this.declaration(node.declaration);
      else this.value('default', null, node.declaration);
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) this.declaration(node.declaration);
    } else {
      this.declaration(node);
    }
  }

  /** A function, class or variables declared at the top level, each by its name. */
  declaration(node: Statement | Expression): void {
    if (node.type === 'FunctionDeclaration' && node.id) {
      this.add(node.id.name, null, node, this.params(node));
    } else if (node.type === 'ClassDeclaration' && node.id) {
      this.klass(node.id.name, node.body);
    } else if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.init)
          this.value(declarator.id.name, null, declarator.init);
      }
    }
  }
}

/** A file's units and top-level bindings, or none when it does not parse. */
export function unitsOf(path: string, source: string): FileUnits {
  try {
    const plugins: ('typescript' | 'jsx')[] = /\.[cm]?tsx?$/.test(path) ? ['typescript'] : [];
    if (path.endsWith('x')) plugins.push('jsx');
    const file = parse(source, { sourceType: 'module', plugins, errorRecovery: true });
    const reader = new Reader(source);
    for (const statement of file.program.body) {
      reader.statement(statement);
      reader.binding(statement);
    }
    return { units: reader.units, bindings: reader.bindings };
  } catch {
    return { units: [], bindings: [] };
  }
}
