import type { CallSymbol, CallsReport, ChangedUnit, Lines } from '@conservationtv/runner/calls';
import type { ContractChange, Review, ReviewFile, Thread } from '../shared/review.ts';
import { connectionsOf, operationParts } from './story.ts';

// A pull request read as topics rather than kinds of file: each topic is one thing that changed, from where it is
// entered down through the calls into whatever else changed under it, with what follows from it alongside: the API
// operation it serves and its contract, the migration for the tables it uses, what was generated from it, and the
// threads on its lines. Built from the runner's calls report (tools/runner, TypeScript's own language server); without
// one, each changed source file is a topic of its own.

export type TopicKind = 'operation' | 'change' | 'file' | 'database' | 'rest';

/** A changed unit in a topic's call tree: how deep, and whether it was shown under another topic already. */
export interface TopicNode {
  unit: ChangedUnit;
  depth: number;
  /** The topic that shows it, when that is another: it is linked to rather than repeated. */
  elsewhere: string | null;
}

/** Part of a changed file: the hunks a topic shows, or all of it. */
export interface TopicFile {
  file: ReviewFile;
  /** The hunks shown, as a patch; the whole patch when `whole`. */
  patch: string | null;
  whole: boolean;
  /** What the part is to the topic, shown beside its title. */
  role: string | null;
}

export interface Topic {
  id: string;
  title: string;
  /** A second line: the operation's id, a file's directory. */
  subtitle: string | null;
  kind: TopicKind;
  nodes: TopicNode[];
  /** Unchanged symbols that use the topic's changed units: where the change is entered from. */
  enteredFrom: CallSymbol[];
  operations: ContractChange[];
  /** What to read, in order: the code, then migrations and contracts, then generated output (folded). */
  files: TopicFile[];
  threads: Thread[];
  additions: number;
  deletions: number;
}

/** A patch's hunks with the lines each covers at the head. */
interface Hunk {
  text: string;
  lines: Lines;
  additions: number;
  deletions: number;
}

function hunksOf(patch: string | null): Hunk[] {
  if (!patch) return [];
  return patch.split(/\n(?=@@ )/).map(text => {
    const [, start = '1', count = '1'] = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/) ?? [];
    const body = text.split('\n').slice(1);
    return {
      text,
      lines: { start: Number(start), end: Number(start) + Math.max(Number(count), 1) - 1 },
      additions: body.filter(line => line.startsWith('+')).length,
      deletions: body.filter(line => line.startsWith('-')).length
    };
  });
}

function overlaps(a: Lines, b: Lines): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'topic'
  );
}

/** A topic being gathered: its units, and every hunk claimed for it, by file. */
interface Draft {
  topic: Topic;
  units: Set<string>;
  hunks: Map<string, Set<number>>;
}

/** Ids handed out so far, so a second topic of the same name gets a number. */
const takenIds = new Map<string, number>();

function draft(base: string, title: string, subtitle: string | null, kind: TopicKind): Draft {
  const count = takenIds.get(base) ?? 0;
  takenIds.set(base, count + 1);
  const topic: Topic = {
    id: count ? `${base}-${count + 1}` : base,
    title,
    subtitle,
    kind,
    nodes: [],
    enteredFrom: [],
    operations: [],
    files: [],
    threads: [],
    additions: 0,
    deletions: 0
  };
  return { topic, units: new Set(), hunks: new Map() };
}

/** What the builder reads from: the review, its files' hunks, and the report's graph. */
interface Reading {
  review: Review;
  files: Map<string, ReviewFile>;
  hunks: Map<string, Hunk[]>;
  units: Map<string, ChangedUnit>;
  /** Changed units each unit uses, by id. */
  uses: Map<string, string[]>;
  /** Each unit's unchanged users. */
  usedBy: Map<string, CallSymbol[]>;
  /** Which topic each hunk went to, by `path#index`. */
  claimed: Map<string, string>;
}

/** Puts the hunks of a file that overlap `lines` in a topic, unless another topic has them already. */
function claim(reading: Reading, into: Draft, path: string, lines: readonly Lines[] | 'all'): void {
  const hunks = reading.hunks.get(path) ?? [];
  hunks.forEach((hunk, index) => {
    // Each hunk goes to the first topic that claims it, and only when it is on the lines asked for.
    const key = `${path}#${index}`;
    if (reading.claimed.has(key)) return;
    if (lines !== 'all' && !lines.some(range => overlaps(range, hunk.lines))) return;
    reading.claimed.set(key, into.topic.id);
    const taken = into.hunks.get(path) ?? new Set<number>();
    taken.add(index);
    into.hunks.set(path, taken);
  });
}

/**
 * Adds a unit and what it uses to a topic, depth first. A unit another topic already holds is linked to, not
 * followed, so each is read once.
 */
function gather(reading: Reading, into: Draft, id: string, depth: number, owner: Map<string, string>): void {
  const unit = reading.units.get(id);
  if (!unit || into.units.has(id)) return;
  const elsewhere = owner.get(id) ?? null;
  into.topic.nodes.push({ unit, depth, elsewhere });
  into.units.add(id);
  if (elsewhere) return;
  owner.set(id, into.topic.id);
  claim(reading, into, unit.path, unit.changed);
  for (const next of reading.uses.get(id) ?? []) gather(reading, into, next, depth + 1, owner);
}

/** The report as a graph: units by id, the changed units each uses, and the unchanged symbols using each. */
function graphOf(report: CallsReport): Pick<Reading, 'units' | 'uses' | 'usedBy'> {
  const units = new Map(report.units.map(unit => [unit.id, unit]));
  const callers = new Map(report.callers.map(caller => [caller.id, caller]));
  const uses = new Map<string, string[]>();
  const usedBy = new Map<string, CallSymbol[]>();
  for (const call of report.calls) {
    // A use between two changed units is followed; one from an unchanged symbol says where the change is entered.
    if (units.has(call.from)) uses.set(call.from, [...(uses.get(call.from) ?? []), call.to]);
    const caller = callers.get(call.from);
    if (caller) usedBy.set(call.to, [...(usedBy.get(call.to) ?? []), caller]);
  }
  return { units, uses, usedBy };
}

/** The units nothing else changed uses: where each topic starts. Those only reachable in a cycle start one too. */
function roots(reading: Reading): string[] {
  const used = new Set([...reading.uses.values()].flat());
  const starts = [...reading.units.keys()].filter(id => !used.has(id));
  const reached = new Set<string>();
  const visit = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    reading.uses.get(id)?.forEach(visit);
  };
  starts.forEach(visit);
  return [...starts, ...[...reading.units.keys()].filter(id => !reached.has(id))];
}

/** How much a unit leads to: units reached under it. Bigger topics come first. */
function reach(reading: Reading, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  return 1 + (reading.uses.get(id) ?? []).reduce((sum, next) => sum + reach(reading, next, seen), 0);
}

/** Each operation's topic: its route's changed units (and what they use), its contract and its generated output. */
function operationTopics(reading: Reading, owner: Map<string, string>): Draft[] {
  return reading.review.contracts.map(change => {
    // The route's hunks naming the operation bring the units they touch; the document and generated output follow.
    const [id, version] = operationParts(change.operation);
    const into = draft(
      `op-${slug(`${id}-v${version}`)}`,
      `${change.method} ${change.path}`,
      change.operation,
      'operation'
    );
    into.topic.operations.push(change);
    const connections = connectionsOf(change, reading.review.files);
    for (const connection of connections.filter(each => each.role === 'route')) {
      const lines = hunksOf(connection.patch).map(hunk => hunk.lines);
      const routeUnits = [...reading.units.values()].filter(
        unit => unit.path === connection.file.path && unit.changed.some(range => lines.some(l => overlaps(l, range)))
      );
      for (const unit of routeUnits) gather(reading, into, unit.id, 0, owner);
      claim(reading, into, connection.file.path, lines);
    }
    for (const connection of connections.filter(each => each.role !== 'route')) {
      claim(
        reading,
        into,
        connection.file.path,
        connection.partial ? hunksOf(connection.patch).map(h => h.lines) : 'all'
      );
    }
    return into;
  });
}

/** The tables a migration creates, alters or drops. */
function tablesOf(patch: string | null): string[] {
  const names = [
    ...(patch ?? '').matchAll(/(?:TABLE|INTO|REFERENCES)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?(?:\w+"?\."?)?(\w+)"?/gi)
  ];
  return [...new Set(names.map(match => match[1] ?? '').filter(Boolean))];
}

/**
 * Each migration joins the topic whose changed code names one of its tables; one no code names is a database topic
 * of its own, with its snapshot.
 */
function migrationTopics(reading: Reading, drafts: Draft[]): Draft[] {
  const own: Draft[] = [];
  for (const file of reading.review.files.filter(each => each.category === 'migration')) {
    // The first topic whose hunks quote one of its tables takes it; else it is a topic of its own.
    const tables = tablesOf(file.patch);
    const named = drafts.find(each =>
      [...each.hunks].some(([path, indexes]) =>
        [...indexes].some(index => {
          const text = reading.hunks.get(path)?.[index]?.text ?? '';
          return tables.some(table => text.includes(`'${table}'`) || text.includes(`"${table}"`));
        })
      )
    );
    const folder = file.path.split('/').at(-2) ?? file.path;
    const into = named ?? draft(`db-${slug(folder)}`, `Migration ${folder}`, tables.join(', ') || null, 'database');
    claim(reading, into, file.path, 'all');
    const snapshot = file.path.replace(/migration\.sql$/, 'snapshot.json');
    if (reading.files.has(snapshot)) claim(reading, into, snapshot, 'all');
    if (!named) own.push(into);
  }
  return own;
}

/** A topic's parts of files, in reading order, each whole or as the hunks it claimed. */
function filesOf(reading: Reading, into: Draft): TopicFile[] {
  const order = { source: 0, migration: 1, contract: 2, generated: 3, lockfile: 4 };
  return [...into.hunks]
    .map(([path, indexes]): TopicFile | null => {
      const file = reading.files.get(path);
      const hunks = reading.hunks.get(path) ?? [];
      if (!file) return null;
      const whole = indexes.size === hunks.length;
      const patch = whole
        ? file.patch
        : hunks
            .filter((_, index) => indexes.has(index))
            .map(h => h.text)
            .join('\n');
      return { file, patch, whole, role: file.generator };
    })
    .filter(each => each !== null)
    .toSorted((a, b) => order[a.file.category] - order[b.file.category]);
}

/** Threads on a topic's lines: on a hunk it shows, or anywhere in a file it shows whole. */
function threadsOf(reading: Reading, into: Draft): Thread[] {
  return reading.review.threads.filter(thread => {
    const indexes = into.hunks.get(thread.path);
    if (!indexes) return false;
    const hunks = reading.hunks.get(thread.path) ?? [];
    if (thread.line === null) return indexes.size === hunks.length;
    return [...indexes].some(index => {
      // On a line of a hunk the topic shows, at the head.
      const lines = hunks[index]?.lines;
      return lines !== undefined && thread.line !== null && thread.line >= lines.start && thread.line <= lines.end;
    });
  });
}

/**
 * Threads no topic shows a line of (on code that has since changed, or outside the hunks) go to the first topic that
 * shows their file at all, else the last: none is left out.
 */
function withStrayThreads(threads: readonly Thread[], topics: Topic[]): Topic[] {
  const shown = new Set(topics.flatMap(topic => topic.threads));
  for (const thread of threads.filter(each => !shown.has(each))) {
    const home = topics.find(topic => topic.files.some(part => part.file.path === thread.path)) ?? topics.at(-1);
    home?.threads.push(thread);
  }
  return topics;
}

/** A topic finished: its parts of files, threads, line counts and where it is entered from. */
function finish(reading: Reading, into: Draft): Topic {
  const files = filesOf(reading, into);
  const counted = [...into.hunks].flatMap(([path, indexes]) => [...indexes].map(i => reading.hunks.get(path)?.[i]));
  const callers = new Map(
    [...into.units].flatMap(id => reading.usedBy.get(id) ?? []).map(caller => [caller.id, caller])
  );
  return {
    ...into.topic,
    files,
    threads: threadsOf(reading, into),
    enteredFrom: [...callers.values()],
    additions: counted.reduce((sum, hunk) => sum + (hunk?.additions ?? 0), 0),
    deletions: counted.reduce((sum, hunk) => sum + (hunk?.deletions ?? 0), 0)
  };
}

/** A unit's name as a reader would say it: a route's callback as its route, `post('/x') callback` as `POST /x`. */
export function unitTitle(name: string): string {
  const route = name.match(/^(get|post|put|patch|delete|all|on)\((['"`])(.*?)\2\) callback$/i);
  return route ? `${route[1]?.toUpperCase()} ${route[3]}` : name;
}

/** Topics started from changed units: one per root with something under it; lone roots gathered by their file. */
function changeTopics(reading: Reading, owner: Map<string, string>): Draft[] {
  const ordered = roots(reading)
    .filter(id => !owner.has(id))
    .toSorted((a, b) => reach(reading, b) - reach(reading, a));
  const byFile = new Map<string, Draft>();
  const drafts: Draft[] = [];
  for (const id of ordered) {
    // A root with changed units under it leads a topic; one alone joins its file's topic.
    const unit = reading.units.get(id);
    if (!unit || owner.has(id)) continue;
    if ((reading.uses.get(id) ?? []).some(next => !owner.has(next))) {
      const title = unitTitle(unit.name);
      const into = draft(`fn-${slug(`${title}-${unit.path.split('/').at(-1)}`)}`, title, unit.path, 'change');
      gather(reading, into, id, 0, owner);
      drafts.push(into);
      continue;
    }
    const existing = byFile.get(unit.path);
    const into =
      existing ?? draft(`file-${slug(unit.path)}`, unit.path.split('/').at(-1) ?? unit.path, unit.path, 'file');
    if (!existing) {
      byFile.set(unit.path, into);
      drafts.push(into);
    }
    gather(reading, into, id, 0, owner);
  }
  return drafts;
}

/** The changed files nothing else claimed all of, by kind: config, docs, workflows, generated and the lockfile. */
function restTopic(reading: Reading): Draft {
  const into = draft('everything-else', 'Everything else', null, 'rest');
  for (const file of reading.review.files) claim(reading, into, file.path, 'all');
  return into;
}

/**
 * Each changed source file as a topic of its own, but those another topic has all of: how the pull request reads
 * without a calls report, and where source changes outside any unit go (types, one-line values, top-level code).
 */
function fileTopics(reading: Reading): Draft[] {
  return reading.review.files
    .filter(file => file.category === 'source')
    .filter(file =>
      (reading.hunks.get(file.path) ?? []).some((_, index) => !reading.claimed.has(`${file.path}#${index}`))
    )
    .map(file => {
      const into = draft(`file-${slug(file.path)}`, file.path.split('/').at(-1) ?? file.path, file.path, 'file');
      claim(reading, into, file.path, 'all');
      return into;
    });
}

/** The pull request's topics, in reading order: operations, then changes by how much they reach, then the rest. */
export function topicsOf(review: Review, report: CallsReport | null): Topic[] {
  const graph = report ? graphOf(report) : { units: new Map(), uses: new Map(), usedBy: new Map() };
  const reading: Reading = {
    review,
    files: new Map(review.files.map(file => [file.path, file])),
    // Files GitHub didn't inline have no hunks: they can only be claimed whole, by the rest.
    hunks: new Map(review.files.map(file => [file.path, hunksOf(file.patch)])),
    ...graph,
    claimed: new Map()
  };
  takenIds.clear();
  const owner = new Map<string, string>();
  const operations = operationTopics(reading, owner);
  const changes = report ? changeTopics(reading, owner) : fileTopics(reading);
  const database = migrationTopics(reading, [...operations, ...changes]);
  const drafts = [...operations, ...changes, ...database];
  // Unclaimed hunks of a file a topic shows go to that topic: imports and the like belong with the code.
  for (const into of drafts) for (const path of into.hunks.keys()) claim(reading, into, path, 'all');
  const leftover = report ? fileTopics(reading) : [];
  const rest = restTopic(reading);
  const topics = [...drafts, ...leftover, rest]
    .filter(into => into.hunks.size > 0 || into.topic.operations.length > 0)
    .map(into => finish(reading, into));
  return withStrayThreads(review.threads, topics);
}

/** The topic a thread is read in, by its id, for linking to it from elsewhere. */
export function topicOfThread(topics: readonly Topic[], thread: Thread): string | null {
  return topics.find(topic => topic.threads.includes(thread))?.id ?? null;
}
