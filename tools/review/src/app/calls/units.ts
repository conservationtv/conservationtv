import { parse } from '@babel/parser';
import type { CallExpression, ClassBody, Expression, Node, ObjectExpression, Statement } from '@babel/types';

// A source file as the functions it defines and the calls each makes, read from its syntax alone: what a reviewer
// follows by eye, without the type checker.

/** A call made inside a unit: what is called, as written, and with what. */
export interface Call {
  /** `ScheduleCheck.validate`, `this.check` or `run`: dotted names only; null when the callee is an expression. */
  callee: string | null;
  /** The callee as written, for showing: `CodeMode.make(...).execute`. */
  text: string;
  args: string;
  line: number;
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

/** Every node within `node`, depth first, `node` itself first. */
function* walk(node: Node): Generator<Node> {
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (NOT_CHILDREN.has(key)) continue;
    // A child is a node or a list of them; everything else on a node is a plain value.
    const children: (MaybeNode | null)[] = Array.isArray(value) ? value : [value];
    for (const child of children) if (child instanceof Object && isNode(child)) yield* walk(child);
  }
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

class Reader {
  readonly units: Unit[] = [];
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
    return {
      callee: this.dotted(node.callee),
      text: this.shown(node.callee),
      args: squash(node.arguments.map(arg => this.slice(arg)).join(', ')),
      line: node.loc?.start.line ?? 0
    };
  }

  /** Every call inside a node, nested functions and callbacks included, in source order. */
  callsIn(node: Node): Call[] {
    const calls: Call[] = [];
    for (const inner of walk(node)) if (inner.type === 'CallExpression') calls.push(this.call(inner));
    return calls.toSorted((a, b) => a.line - b.line);
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
      calls: this.callsIn(node)
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
      calls: handlers.flatMap(handler => this.callsIn(handler))
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

/** A file's units, or none when it does not parse. */
export function unitsOf(path: string, source: string): Unit[] {
  try {
    const plugins: ('typescript' | 'jsx')[] = /\.[cm]?tsx?$/.test(path) ? ['typescript'] : [];
    if (path.endsWith('x')) plugins.push('jsx');
    const file = parse(source, { sourceType: 'module', plugins, errorRecovery: true });
    const reader = new Reader(source);
    for (const statement of file.program.body) reader.statement(statement);
    return reader.units;
  } catch {
    return [];
  }
}
