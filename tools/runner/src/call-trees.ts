import { parse } from '@babel/parser';
import { VISITOR_KEYS, type Node } from '@babel/types';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CallTree, CallTreeNode, ChangedUnit, Lines } from './calls.ts';
import type { DocumentSymbol, Position } from './lsp.ts';
import { candidates, git, linesOf, openWorkspace, overlaps, worktreeAt, type Workspace } from './workspace.ts';

// Diffed call trees, as calldiff (github.com/tanishqkancharla/calldiff) draws them: from where a change is entered,
// the calls each function makes, in order, at the merge base and at the head, so a call that appeared, went or moved
// shows as such. Calls are read from the syntax (with Babel) and resolved by TypeScript's language server, as
// go-to-definition resolves them: through imports, re-exports, methods and JSX, and never to a different function of
// the same name. What resolves outside the repository (the platform, dependencies) is left out. Only functions the pull
// request changed are opened; what they call that didn't change is shown unopened, so the tree is the change's shape.

/** How deep a tree is followed, and how many calls it may hold: a backstop, as only changed functions open. */
const MAX_DEPTH = 8;
const MAX_NODES = 400;

/** A call in a function's body, in the order it is made: what it is, and where its callee's name is. */
interface Site {
  kind: CallTreeNode['kind'];
  label: string;
  at: Position;
  line: number;
}

/** A function a call resolved to: its key on both sides, and where it is on the side it was read from. */
interface Target {
  key: string;
  name: string;
  path: string;
  lines: Lines;
}

const parsed = new Map<string, Node | null>();

/** A file's syntax tree, with TypeScript and (for .tsx and .jsx) JSX; null when it doesn't parse. */
function syntaxOf(workspace: Workspace, file: string): Node | null {
  const key = `${workspace.root}:${file}`;
  if (parsed.has(key)) return parsed.get(key) ?? null;
  const jsx = /\.[cm]?[jt]sx$/.test(file);
  let tree: Node | null = null;
  try {
    const plugins: ('typescript' | 'jsx')[] = jsx ? ['typescript', 'jsx'] : ['typescript'];
    tree = parse(workspace.open(file).text, { sourceType: 'module', plugins, errorRecovery: true }).program;
  } catch {
    tree = null;
  }
  parsed.set(key, tree);
  return tree;
}

/** Each child node of a syntax node, by Babel's own list of where a node of its type keeps them. */
function childrenOf(node: Node): Node[] {
  const record: Record<string, Node | Node[] | null | undefined> = Object.fromEntries(Object.entries(node));
  return (VISITOR_KEYS[node.type] ?? []).flatMap(key => {
    const value = record[key];
    if (!value) return [];
    return Array.isArray(value) ? value.filter(each => each !== null) : [value];
  });
}

/** Where a callee's own name is: an identifier's start, or a member's property. */
function nameNode(callee: Node): Node | null {
  if (callee.type === 'Identifier' || callee.type === 'JSXIdentifier') return callee;
  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') return callee.property;
  if (callee.type === 'JSXMemberExpression') return callee.property;
  return null;
}

/** What a node calls, and how: a call's or `new`'s callee, or a JSX element's name. */
function calleeOf(node: Node): [Node, Site['kind']] | null {
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') return [node.callee, 'call'];
  if (node.type === 'NewExpression') return [node.callee, 'new'];
  if (node.type === 'JSXOpeningElement') return [node.name, 'jsx'];
  return null;
}

/** A call as written, shortened from the front when long: `new X`, `<X>`, or the callee itself. */
function labelOf(kind: Site['kind'], written: string): string {
  const short = written.length > 48 ? `…${written.slice(-47)}` : written;
  if (kind === 'new') return `new ${short}`;
  return kind === 'jsx' ? `<${short}>` : short;
}

/** A call, `new` or JSX element as a site, when its callee is named. */
function siteOf(node: Node, text: string): Site | null {
  const found = calleeOf(node);
  if (!found) return null;
  const [callee, kind] = found;
  const named = nameNode(callee);
  if (!named?.loc || callee.start == null || callee.end == null) return null;
  const written = text.slice(callee.start, callee.end).replace(/\s+/g, '');
  // A JSX element is a component only when its name starts with a capital: `<div>` is the platform's.
  if (kind === 'jsx' && !/^[A-Z]/.test(written.split('.').at(-1) ?? '')) return null;
  const at = { line: named.loc.start.line - 1, character: named.loc.start.column };
  return { kind, label: labelOf(kind, written), at, line: named.loc.start.line };
}

/** The calls made within some lines of a file, in the order they are written. */
function sitesIn(workspace: Workspace, file: string, lines: Lines): Site[] {
  const tree = syntaxOf(workspace, file);
  if (!tree) return [];
  const text = workspace.open(file).text;
  const sites: Site[] = [];
  const visit = (node: Node) => {
    // Only what overlaps the lines is walked into; a site is taken when it starts within them.
    const start = node.loc?.start.line ?? 0;
    const end = node.loc?.end.line ?? Number.MAX_SAFE_INTEGER;
    if (end < lines.start || start > lines.end) return;
    const site = start >= lines.start ? siteOf(node, text) : null;
    if (site) sites.push(site);
    childrenOf(node).forEach(visit);
  };
  visit(tree);
  return sites.toSorted((a, b) => a.at.line - b.at.line || a.at.character - b.at.character);
}

function keyOf(file: string, name: string): string {
  return `${file}#${name}`;
}

/** The function a call resolves to, when it is in the repository and inside a function, method or value of it. */
async function resolve(workspace: Workspace, file: string, site: Site): Promise<Target | null> {
  const [found] = await workspace.server.definition(path.join(workspace.root, file), site.at).catch(() => []);
  const target = found ? workspace.pathOf(found) : null;
  if (!found || !target) return null;
  const symbol: DocumentSymbol | null = await workspace.around(target, found.range.start.line + 1);
  // Only a definition at a symbol's own name is a call to it: one inside it is a property or local of its body.
  if (!symbol || symbol.selectionRange.start.line !== found.range.start.line) return null;
  return { key: keyOf(target, symbol.name), name: symbol.name, path: target, lines: linesOf(symbol) };
}

/** One side's tree: its workspace, which functions changed on it, and how many calls it holds so far. */
interface Side {
  name: 'base' | 'head';
  workspace: Workspace;
  /** Changed functions by key: these are opened. */
  changed: Set<string>;
  count: number;
}

/** A function's calls at one side, opening each changed callee in turn. */
async function treeAt(
  side: Side,
  target: Target,
  call: Pick<CallTreeNode, 'kind' | 'label' | 'site'>,
  open: ReadonlySet<string>
): Promise<CallTreeNode> {
  side.count++;
  const changed = side.changed.has(target.key);
  const recursive = open.has(target.key);
  const node: CallTreeNode = {
    key: target.key,
    ...call,
    path: target.path,
    lines: target.lines,
    side: side.name,
    status: 'same',
    changed,
    recursive,
    children: []
  };
  if (!changed || recursive || open.size >= MAX_DEPTH || side.count > MAX_NODES) return node;
  const inner = new Set([...open, target.key]);
  const seen = new Set<string>();
  for (const site of sitesIn(side.workspace, target.path, target.lines)) {
    // Each function it calls once, where it first calls it; calls back into itself are left out.
    const callee = await resolve(side.workspace, target.path, site);
    if (!callee || callee.key === target.key || seen.has(callee.key)) continue;
    seen.add(callee.key);
    node.children.push(await treeAt(side, callee, { kind: site.kind, label: site.label, site: site.line }, inner));
  }
  return node;
}

/** Marks a whole subtree as only on one side. */
function only(node: CallTreeNode, status: 'added' | 'removed'): CallTreeNode {
  return { ...node, status, children: node.children.map(child => only(child, status)) };
}

/** The base's calls the head no longer makes, among some of them. */
function gone(calls: readonly CallTreeNode[], headKeys: ReadonlySet<string>): CallTreeNode[] {
  return calls.filter(call => !headKeys.has(call.key)).map(call => only(call, 'removed'));
}

/**
 * Two sides of a call as one node: the head's, with its children merged in the head's order and those only at the
 * base placed where they were. A call only at the base is marked removed where its parent's merge finds it.
 */
function merge(base: CallTreeNode | null, head: CallTreeNode): CallTreeNode {
  if (!base) return only(head, 'added');
  const children: CallTreeNode[] = [];
  const headKeys = new Set(head.children.map(child => child.key));
  let next = 0;
  for (const child of head.children) {
    // The base's calls up to this one's place there go first, those the head no longer makes as removed.
    const at = base.children.findIndex((each, index) => index >= next && each.key === child.key);
    if (at < 0) {
      children.push(only(child, 'added'));
      continue;
    }
    children.push(...gone(base.children.slice(next, at), headKeys), merge(base.children[at] ?? null, child));
    next = at + 1;
  }
  children.push(...gone(base.children.slice(next), headKeys));
  return { ...head, changed: head.changed || base.changed, children };
}

/** A call that went from under one function and appeared under another moved: both say so. */
function markMoves(tree: CallTreeNode): CallTreeNode {
  const added = new Set<string>();
  const removed = new Set<string>();
  const collect = (node: CallTreeNode) => {
    if (node.status === 'added') added.add(node.key);
    if (node.status === 'removed') removed.add(node.key);
    node.children.forEach(collect);
  };
  collect(tree);
  const mark = (node: CallTreeNode): CallTreeNode => {
    const moved = node.status !== 'same' && added.has(node.key) && removed.has(node.key);
    return { ...node, status: moved ? 'moved' : node.status, children: node.children.map(mark) };
  };
  return mark(tree);
}

/** The changed functions at the base: those whose lines the pull request removed or changed. */
async function baseChanged(workspace: Workspace, lines: Map<string, Lines[]>): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const [file, ranges] of lines) {
    // Source files the base has: their units with a line the pull request removed or changed.
    if (!existsSync(path.join(workspace.root, file)) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
    const symbols = await workspace.open(file).symbols;
    for (const symbol of candidates(symbols)) {
      if (ranges.some(range => overlaps(range, linesOf(symbol)))) keys.add(keyOf(file, symbol.name));
    }
  }
  return keys;
}

/** The function of a name in a file at the base, if it was there. */
async function atBase(workspace: Workspace, unit: ChangedUnit): Promise<Target | null> {
  if (!existsSync(path.join(workspace.root, unit.path))) return null;
  const symbols = await workspace.open(unit.path).symbols;
  const symbol = candidates(symbols).find(each => each.name === unit.name);
  return symbol ? { key: keyOf(unit.path, unit.name), name: unit.name, path: unit.path, lines: linesOf(symbol) } : null;
}

export interface TreeInput {
  root: string;
  base: string;
  head: Workspace;
  units: readonly ChangedUnit[];
  /** The units no other changed unit uses: where each tree starts. */
  roots: readonly ChangedUnit[];
  baseLines: Map<string, Lines[]>;
}

/** The diffed call tree from each root, base against head. */
export async function callTrees(input: TreeInput): Promise<CallTree[]> {
  const dir = worktreeAt(input.root, input.base);
  const baseWorkspace = await openWorkspace(dir);
  try {
    const headChanged = new Set(input.units.map(unit => keyOf(unit.path, unit.name)));
    const changedBase = await baseChanged(baseWorkspace, input.baseLines);
    const trees: CallTree[] = [];
    for (const unit of input.roots) {
      // Each side opens what changed on either: a function only one side changed still differs between them.
      const changed = new Set([...headChanged, ...changedBase]);
      const head: Side = { name: 'head', workspace: input.head, changed, count: 0 };
      const base: Side = { name: 'base', workspace: baseWorkspace, changed, count: 0 };
      const target: Target = { key: keyOf(unit.path, unit.name), name: unit.name, path: unit.path, lines: unit.lines };
      const root = { kind: 'root' as const, label: unit.name, site: null };
      const headTree = await treeAt(head, target, root, new Set());
      const baseTarget = await atBase(baseWorkspace, unit);
      const baseTree = baseTarget ? await treeAt(base, baseTarget, root, new Set()) : null;
      trees.push({ root: unit.id, tree: markMoves(merge(baseTree, headTree)) });
    }
    return trees;
  } finally {
    baseWorkspace.close();
    git(input.root, ['worktree', 'remove', '--force', dir]);
  }
}
