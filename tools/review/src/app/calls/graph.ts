import { unitsOf, type Binding, type Call, type Unit } from './units.ts';

// The changed functions of a pull request as the calls between them: each tree starts where the change is entered,
// from a function that did not change when one calls in, and follows calls into whatever else changed. A unit is what
// a name is bound to, read with the changed declarations of its file it is built from; a call is a place in its caller.

/** A source file at the merge base and at the head; null on the side it does not exist. */
export interface Sides {
  path: string;
  before: string | null;
  after: string | null;
}

export type Status = 'new' | 'changed' | 'same';

/** Lines of a file: where they start and end, and what they say. */
export interface Span {
  start: number;
  end: number;
  text: string;
}

/** A declaration a unit is built from, at the head and as it was; null where it is new. */
export interface Piece {
  after: Span;
  before: Span | null;
}

/** A unit at the head, where it is, what it was, and the changed declarations it is built from. */
export interface Located extends Unit {
  id: string;
  path: string;
  status: Status;
  /**
   * What its name was bound to at the merge base: the unit of that name, else the statement binding it, such as the
   * re-export `export { cn } from "cn"` a function replaced.
   */
  previous: Span | null;
  /**
   * The top-level declarations of its file it uses that changed, other than what it calls, in file order: the values it
   * is made from, such as `customTextSizes` for `cn`, and in turn what they are made from; and, for a unit that was
   * there before, the imports it newly uses, such as `createCn`.
   */
  context: Piece[];
}

export interface CallNode {
  unit: Located;
  /** Each call its parent makes to it, in the parent's order; none at the top of a tree. */
  calls: Call[];
  children: CallNode[];
  /** Called again from within its own calls: its children are left out. */
  recursive: boolean;
}

/** A unit at the merge base with none of its name at the head. */
export interface RemovedUnit {
  path: string;
  name: string;
}

/** A file's units at the head, its bindings on both sides, and the names it no longer defines. */
interface LocatedFile {
  path: string;
  units: Located[];
  before: Binding[];
  after: Binding[];
  removed: string[];
}

export interface CallGraph {
  roots: CallNode[];
  added: number;
  changed: number;
  /** Files with a changed unit. */
  files: number;
  /** Units that are gone, by file. */
  removed: RemovedUnit[];
  /** Script files whose changes are outside any unit, and changed files that are not scripts. */
  elsewhere: string[];
}

/** Text compared without its indentation and blank lines, so reformatting alone is not a change. */
function normalised(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function statusOf(unit: Unit, previous: Span | null): Status {
  if (!previous) return 'new';
  return normalised(previous.text) === normalised(unit.text) ? 'same' : 'changed';
}

/** The statement binding a name, if one does. */
function bindingOf(bindings: readonly Binding[], name: string): Binding | undefined {
  return bindings.find(binding => binding.names.includes(name));
}

/** Whether a name is bound the same way on both sides: an import to the same thing, else by the same statement. */
function sameBinding(name: string, before: Binding, after: Binding): boolean {
  if (before.imports && after.imports) return before.imports[name] === after.imports[name];
  return normalised(before.text) === normalised(after.text);
}

/** Every unit at the head, with what its name was bound to at the merge base. */
function locate(sides: Sides): LocatedFile {
  const before = sides.before === null ? { units: [], bindings: [] } : unitsOf(sides.path, sides.before);
  const after = sides.after === null ? { units: [], bindings: [] } : unitsOf(sides.path, sides.after);
  const previous = new Map(before.units.map(unit => [unit.name, unit]));
  const units = after.units.map(unit => {
    // A top-level name with no unit at the merge base may have been bound otherwise: re-exported, or a plain value.
    const was = previous.get(unit.name) ?? (unit.owner === null ? bindingOf(before.bindings, unit.name) : undefined);
    const span = was ? { start: was.start, end: was.end, text: was.text } : null;
    return {
      ...unit,
      id: `${sides.path}#${unit.name}`,
      path: sides.path,
      status: statusOf(unit, span),
      previous: span
    };
  });
  const names = new Set(after.units.map(unit => unit.name));
  return {
    path: sides.path,
    units: units.map(unit => ({ ...unit, context: [] })),
    before: before.bindings,
    after: after.bindings,
    removed: before.units.filter(unit => !names.has(unit.name)).map(unit => unit.name)
  };
}

/**
 * The changed top-level declarations a unit is built from, in file order: those binding a name it uses, other than its
 * own statement and the names in `called`, which are read as calls; and in turn the changed ones those use. Imports
 * only for a unit that was there before: everything a new one imports is new with it.
 */
function contextOf(unit: Located, file: LocatedFile, called: ReadonlySet<string>): Piece[] {
  const pieces = new Map<number, Piece>();
  const seen = new Set<string>([unit.name]);
  const queue = [...unit.uses];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name) || called.has(name)) continue;
    seen.add(name);
    const found = changedBinding(unit, file, name);
    if (!found) continue;
    pieces.set(found.piece.after.start, found.piece);
    queue.push(...found.uses);
  }
  return [...pieces.values()].toSorted((a, b) => a.after.start - b.after.start);
}

/** Lines of a file as a span. */
function spanOf({ start, end, text }: Span): Span {
  return { start, end, text };
}

/** A changed declaration a unit is built from, and the names it uses in turn. */
interface ChangedBinding {
  piece: Piece;
  uses: string[];
}

/**
 * The top-level statement binding a name a unit uses, as a piece of the unit, and the names it uses in turn; null when
 * it did not change, or is not one to show with the unit.
 */
function changedBinding(unit: Located, file: LocatedFile, name: string): ChangedBinding | null {
  const after = bindingOf(file.after, name);
  // A name bound by no top-level statement is a local or a global; the unit's own statement is the unit; and
  // everything a new unit imports is new with it.
  if (!after || (after.start <= unit.start && after.end >= unit.end)) return null;
  if (after.imports && unit.status === 'new') return null;
  const before = bindingOf(file.before, name);
  if (before && sameBinding(name, before, after)) return null;
  return { piece: { after: spanOf(after), before: before ? spanOf(before) : null }, uses: after.uses };
}

/** The units within the declarations a unit is built from. */
function builtFrom(unit: Located, units: readonly Located[]): Located[] {
  return units.filter(
    other =>
      other.path === unit.path &&
      unit.context.some(piece => other.start >= piece.after.start && other.end <= piece.after.end)
  );
}

class Resolver {
  private readonly byName: Map<string, Located[]>;

  constructor(units: readonly Located[]) {
    this.byName = Map.groupBy(units, unit => unit.name);
  }

  /**
   * The unit a call reaches, by name: `this.x` within its own class or object, else the name as written, preferring
   * the caller's own file when several files define it.
   */
  resolve(call: Call, from: Located): Located | undefined {
    if (call.callee === null) return undefined;
    const name = call.callee.startsWith('this.') && from.owner ? `${from.owner}${call.callee.slice(4)}` : call.callee;
    const candidates = this.byName.get(name) ?? [];
    return candidates.find(unit => unit.path === from.path) ?? candidates[0];
  }

  /** The changed units a unit calls, in the order it first calls each, with every call it makes to it. */
  callees(unit: Located): [Call[], Located][] {
    const found = new Map<string, [Call[], Located]>();
    for (const call of unit.calls) {
      // Calls that reach nothing, an unchanged unit or the unit itself are passed over.
      const target = this.resolve(call, unit);
      if (!target || target.status === 'same' || target.id === unit.id) continue;
      const entry = found.get(target.id);
      if (entry) entry[0].push(call);
      else found.set(target.id, [[call], target]);
    }
    return [...found.values()];
  }
}

const MAX_DEPTH = 12;

function grow(resolver: Resolver, unit: Located, calls: Call[], trail: ReadonlySet<string>): CallNode {
  const recursive = trail.has(unit.id);
  const next = new Set([...trail, unit.id]);
  const children =
    recursive || trail.size >= MAX_DEPTH
      ? []
      : resolver.callees(unit).map(([inner, target]) => grow(resolver, target, inner, next));
  return { unit, calls, children, recursive };
}

/**
 * The changed units of the script files as call trees: entered from changed units nothing changed calls, or from the
 * unchanged ones that do. `others` are the changed files that are not scripts.
 */
export function callGraph(files: readonly Sides[], others: readonly string[]): CallGraph {
  const located = files.map(locate);
  // Each unit read with the changed declarations it is built from, other than the units it calls: those are its calls.
  const bare = new Resolver(located.flatMap(file => file.units));
  for (const file of located) {
    file.units = file.units.map(unit => {
      const called = new Set(
        unit.calls.flatMap(call => (call.callee !== null && bare.resolve(call, unit) ? [call.callee] : []))
      );
      return { ...unit, context: contextOf(unit, file, called) };
    });
  }
  const units = located.flatMap(file => file.units);
  const resolved = new Resolver(units);
  const changed = units.filter(unit => unit.status !== 'same');

  // A changed unit another changed unit calls is reached from it, and one it is built from is read with it: neither
  // is a tree of its own.
  const reached = new Set([
    ...changed.flatMap(unit => resolved.callees(unit).map(([, target]) => target.id)),
    ...changed.flatMap(unit => builtFrom(unit, units).map(other => other.id))
  ]);
  const entries = changed.filter(unit => !reached.has(unit.id));
  // Entry points an unchanged unit calls are shown under it, so the tree starts from code the reader knows.
  const callers = units.filter(
    unit => unit.status === 'same' && resolved.callees(unit).some(([, target]) => entries.includes(target))
  );
  const covered = new Set(callers.flatMap(unit => resolved.callees(unit).map(([, target]) => target.id)));
  const tops = [...callers, ...entries.filter(unit => !covered.has(unit.id))].toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.start - b.start
  );

  const withUnits = new Set(changed.map(unit => unit.path));
  const elsewhere = files
    .filter(sides => !withUnits.has(sides.path) && sides.before !== sides.after)
    .map(sides => sides.path);
  return {
    roots: tops.map(unit => grow(resolved, unit, [], new Set())),
    added: changed.filter(unit => unit.status === 'new').length,
    changed: changed.filter(unit => unit.status === 'changed').length,
    files: withUnits.size,
    removed: located.flatMap(file => file.removed.map(name => ({ path: file.path, name }))),
    elsewhere: [...elsewhere, ...others]
  };
}
