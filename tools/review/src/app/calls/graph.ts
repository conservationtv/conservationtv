import { unitsOf, type Call, type Unit } from './units.ts';

// The changed functions of a pull request as the calls between them: each tree starts where the change is entered,
// from a function that did not change when one calls in, and follows calls into whatever else changed.

/** A source file at the merge base and at the head; null on the side it does not exist. */
export interface Sides {
  path: string;
  before: string | null;
  after: string | null;
}

export type Status = 'new' | 'changed' | 'same';

/** A unit at the head, where it is, and what it was. */
export interface Located extends Unit {
  id: string;
  path: string;
  status: Status;
  /** The unit of the same name at the merge base, for its diff. */
  previous: Unit | null;
}

export interface CallNode {
  unit: Located;
  /** How its parent calls it; null at the top of a tree. */
  call: Call | null;
  children: CallNode[];
  /** Called again from within its own calls: its children are left out. */
  recursive: boolean;
}

/** A unit at the merge base with none of its name at the head. */
export interface RemovedUnit {
  path: string;
  name: string;
}

/** A file's units at the head, and the names it no longer defines. */
interface LocatedFile {
  path: string;
  units: Located[];
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

function statusOf(unit: Unit, previous: Unit | null): Status {
  if (!previous) return 'new';
  return normalised(previous.text) === normalised(unit.text) ? 'same' : 'changed';
}

/** Every unit at the head, with what it was at the merge base. */
function locate(sides: Sides): LocatedFile {
  const before = sides.before === null ? [] : unitsOf(sides.path, sides.before);
  const after = sides.after === null ? [] : unitsOf(sides.path, sides.after);
  const previous = new Map(before.map(unit => [unit.name, unit]));
  const units = after.map(unit => {
    const was = previous.get(unit.name) ?? null;
    return { ...unit, id: `${sides.path}#${unit.name}`, path: sides.path, status: statusOf(unit, was), previous: was };
  });
  const names = new Set(after.map(unit => unit.name));
  return { path: sides.path, units, removed: before.filter(unit => !names.has(unit.name)).map(unit => unit.name) };
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

  /** The changed units a unit calls, each once, in the order it first calls them. */
  callees(unit: Located): [Call, Located][] {
    const seen = new Set<string>();
    const found: [Call, Located][] = [];
    for (const call of unit.calls) {
      // Calls that reach nothing, an unchanged unit, the unit itself or one already found are passed over.
      const target = this.resolve(call, unit);
      if (!target || target.status === 'same' || target.id === unit.id || seen.has(target.id)) continue;
      seen.add(target.id);
      found.push([call, target]);
    }
    return found;
  }
}

const MAX_DEPTH = 12;

function grow(resolver: Resolver, unit: Located, call: Call | null, trail: ReadonlySet<string>): CallNode {
  const recursive = trail.has(unit.id);
  const next = new Set([...trail, unit.id]);
  const children =
    recursive || trail.size >= MAX_DEPTH
      ? []
      : resolver.callees(unit).map(([inner, target]) => grow(resolver, target, inner, next));
  return { unit, call, children, recursive };
}

/**
 * The changed units of the script files as call trees: entered from changed units nothing changed calls, or from the
 * unchanged ones that do. `others` are the changed files that are not scripts.
 */
export function callGraph(files: readonly Sides[], others: readonly string[]): CallGraph {
  const located = files.map(locate);
  const units = located.flatMap(file => file.units);
  const resolver = new Resolver(units);
  const changed = units.filter(unit => unit.status !== 'same');

  // A changed unit another changed unit calls is reached from it, so is not a tree of its own.
  const called = new Set(changed.flatMap(unit => resolver.callees(unit).map(([, target]) => target.id)));
  const entries = changed.filter(unit => !called.has(unit.id));
  // Entry points an unchanged unit calls are shown under it, so the tree starts from code the reader knows.
  const callers = units.filter(
    unit => unit.status === 'same' && resolver.callees(unit).some(([, target]) => entries.includes(target))
  );
  const covered = new Set(callers.flatMap(unit => resolver.callees(unit).map(([, target]) => target.id)));
  const tops = [...callers, ...entries.filter(unit => !covered.has(unit.id))].toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.start - b.start
  );

  const withUnits = new Set(changed.map(unit => unit.path));
  const elsewhere = files
    .filter(sides => !withUnits.has(sides.path) && sides.before !== sides.after)
    .map(sides => sides.path);
  return {
    roots: tops.map(unit => grow(resolver, unit, null, new Set())),
    added: changed.filter(unit => unit.status === 'new').length,
    changed: changed.filter(unit => unit.status === 'changed').length,
    files: withUnits.size,
    removed: located.flatMap(file => file.removed.map(name => ({ path: file.path, name }))),
    elsewhere: [...elsewhere, ...others]
  };
}
