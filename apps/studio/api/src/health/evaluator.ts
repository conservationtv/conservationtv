import {
  type Activity,
  type Consulted,
  type Finding,
  type Health,
  isWorse,
  type OpinionState,
  type PendingHealth,
  worstHealth
} from './health.ts';
import type { SubjectMetrics } from './metrics.ts';

// How a reporter's opinion of a subject is formed, for one kind of subject (src/health/evaluators.ts registers one per
// kind). Each evaluation runs in three steps:
//
//   1. `context`: what the subject is meant to be doing, from the topology, such as whether a forward is switched on.
//      Metrics alone can't tell an outage from something that is off.
//   2. `evaluate`: a verdict from the reporter's metrics, which it reads as it needs them (src/health/metrics.ts), and
//      the opinion as last saved. Usually the worst of a few checks (`allOf`, src/health/checks.ts), but it can be any
//      judgement, such as not reading OBS's frame stats while the offline segment plays.
//   3. `settle`: whether to take the verdict yet, from the opinion as last saved, so a subject doesn't flap between
//      healthy and not on every report (`hysteresis`).
//
// Loading the context is the only step that reads the topology, so the rest (`judge`, then `formOpinion`) is a function
// of the context, the metrics and the previous opinion alone, and can be exercised with neither.

/** One subject being judged, from one reporter's reports, as of the newest of them. */
export interface Subject {
  organisationId: string;
  subjectId: string;
  /** The subject's ID after its kind: `exposure:<id>`'s `<id>`. */
  entityId: string;
  reporterId: string;
  at: Date;
}

/** A reporter's opinion of a subject as last saved, if it has one. */
export interface PreviousOpinion {
  health: Health;
  /** `active` for an opinion saved before activity was kept. */
  activity?: Activity;
  state: OpinionState;
  observedAt: Date;
}

export interface EvaluationInput<Context> {
  subject: Subject;
  metrics: SubjectMetrics;
  context: Context;
  previous: PreviousOpinion | undefined;
  /**
   * The most seconds back to judge, when fewer than a check would: set while the subject is recovering, so that what
   * went wrong before it came back doesn't hold it down for a whole window (`formOpinion`). Read with `windowOf`.
   */
  window?: number;
}

/** A window to judge over: at most `window` seconds, when the evaluation has one. */
interface Windowed {
  window?: number;
}

/** The seconds back a check judges: all it asks for, or fewer while the subject is recovering. */
export function windowOf({ window }: Windowed, over: number): number {
  return window === undefined ? over : Math.min(over, window);
}

/** What an evaluation concluded, and why. Only what is `active` is judged: otherwise its health is `unknown`. */
export interface Verdict {
  health: Health;
  activity: Activity;
  findings: Finding[];
}

/** What an opinion settles on: the health it holds, since when, and a change seen but not yet taken. */
export interface Settled {
  health: Health;
  since: Date;
  pending: PendingHealth | null;
}

/** Whether to take a verdict yet, from the opinion as last saved. */
export type Settle = (verdict: Verdict, previous: PreviousOpinion | undefined, at: Date) => Settled;

/** One check of a subject: a finding, or undefined when it doesn't apply, such as to something switched off. */
export type Check<Context> = (input: EvaluationInput<Context>) => Promise<Finding | undefined>;

export interface EvaluatorDefinition<Context> {
  /**
   * How many seconds an opinion holds without another report about the subject from its reporter: a few of the
   * reporter's intervals, after which the subject is stale.
   */
  ttl: number;
  /** What the subject is meant to be doing. Undefined when it no longer exists, as a deleted forward. */
  context?: (subject: Subject) => Promise<Context | undefined>;
  evaluate: (input: EvaluationInput<Context>) => Promise<Verdict>;
  /** `hysteresis()` by default. */
  settle?: Settle;
}

/** What an evaluator judges: a subject, its reporter's metrics, its context if found, and its previous opinion. */
export interface Judging<Context> {
  subject: Subject;
  metrics: SubjectMetrics;
  /** Undefined when the subject is no longer in the topology. */
  context: Context | undefined;
  previous: PreviousOpinion | undefined;
  /** As `EvaluationInput`'s. */
  window?: number;
}

/**
 * An evaluator of one kind of subject. The registry holds them as `Evaluator<unknown>`, and the consumer passes `judge`
 * what `context` loaded, so the two always agree.
 */
export interface Evaluator<Context = unknown> {
  ttl: number;
  context(subject: Subject): Promise<Context | undefined>;
  judge(judging: Judging<Context>): Promise<Verdict>;
  settle: Settle;
}

/** A reporter's opinion of a subject, as it is saved. */
export interface Opinion {
  health: Health;
  activity: Activity;
  state: OpinionState;
  observedAt: Date;
  expiresAt: Date;
}

/** Judge, settle and keep why: the reporter's opinion of the subject, from what the evaluation read. */
export async function formOpinion<Context>(
  evaluator: Evaluator<Context>,
  judging: Judging<Context>,
  consulted: Consulted[]
): Promise<Opinion> {
  const { subject, previous } = judging;
  // Going idle or off, or coming back, is a fact about the subject, not a judgement that might flap: taken at once,
  // and what follows is settled as a first opinion. So is a recovery: it is judged over a short window of its own,
  // which is the time it has held for.
  const wasActive = previous !== undefined && (previous.activity ?? 'active') === 'active';
  const recovered = wasActive ? await recovery(evaluator, judging) : undefined;
  const verdict = recovered ?? (await evaluator.judge({ ...judging, window: establishedWindow(judging) }));
  const judged = verdict.activity === 'active' && wasActive && recovered === undefined;
  const settled = judged
    ? evaluator.settle(verdict, previous, subject.at)
    : firstOpinion(verdict, previous, subject.at);
  const state: OpinionState = {
    findings: verdict.findings,
    consulted,
    since: settled.since.toISOString(),
    pending: settled.pending
  };
  const expiresAt = new Date(subject.at.getTime() + evaluator.ttl * 1000);
  return { health: settled.health, activity: verdict.activity, state, observedAt: subject.at, expiresAt };
}

/**
 * Seconds a subject must have been well for to have recovered: three of an agent's reports. Judging a recovery over
 * the evaluators' whole window would keep a subject down for as long again as it was, however soon it came back.
 */
export const RECOVERY_WINDOW = 45;

const WELL = { healthy: true, degraded: true, unhealthy: false, unknown: false } satisfies Record<Health, boolean>;

/**
 * The verdict of a subject that was unwell and has been better for the recovery window: judged over that alone.
 * Undefined when it wasn't unwell, isn't better over it, or said too little in it to tell, as a reporter that reports
 * less often than the window is long does: then it is judged as ever.
 */
async function recovery<Context>(
  evaluator: Evaluator<Context>,
  judging: Judging<Context>
): Promise<Verdict | undefined> {
  const { previous } = judging;
  if (previous === undefined || previous.health === 'healthy' || previous.health === 'unknown') return undefined;
  const recent = await evaluator.judge({ ...judging, window: RECOVERY_WINDOW });
  const better = recent.activity === 'active' && WELL[recent.health] && isWorse(previous.health, recent.health);
  return better ? recent : undefined;
}

/**
 * The most seconds back an opinion is judged over: as long as it has held its health, and the recovery window before
 * that, which is what it was last taken on. What came before is what it changed from, and has been judged already: a
 * subject taken as recovered would otherwise be found unwell again by the same outage, for as long as that stayed in
 * a check's window. Undefined for a first opinion, judged over all a check asks for.
 */
function establishedWindow<Context>({ previous, subject }: Judging<Context>): number | undefined {
  if (previous === undefined) return undefined;
  const since = new Date(previous.state.since);
  return (subject.at.getTime() - since.getTime()) / 1000 + RECOVERY_WINDOW;
}

/** A verdict taken as it is: since now, unless the opinion already held just that. */
function firstOpinion(verdict: Verdict, previous: PreviousOpinion | undefined, at: Date): Settled {
  const same =
    previous !== undefined &&
    previous.health === verdict.health &&
    (previous.activity ?? 'active') === verdict.activity;
  return { health: verdict.health, since: same ? new Date(previous.state.since) : at, pending: null };
}

/**
 * An evaluator of one kind of subject. A subject whose context can't be found, such as a forward deleted while its
 * output still reports it, is judged `unknown`.
 */
export function defineEvaluator<Context = null>(definition: EvaluatorDefinition<Context>): Evaluator<Context> {
  const { ttl, evaluate, settle = hysteresis() } = definition;
  // Without a context, the evaluator judges by metrics alone.
  // SAFETY: `Context` defaults to `null`, and a definition that names another type must give a loader of it to be
  // useful; one that doesn't is judged with `null`, which its own checks then read.
  const load = definition.context ?? (async () => null as Context);
  return {
    ttl,
    settle,
    context: load,
    async judge({ subject, metrics, context, previous, window }) {
      if (context === undefined)
        return {
          health: 'unknown',
          activity: 'active',
          findings: [unknownFinding('context', 'No longer in the topology')]
        };
      return evaluate({ subject, metrics, context, previous, window });
    }
  };
}

/** A verdict of the worst of `checks`, run together. Checks that don't apply are left out. */
export function allOf<Context>(...checks: Check<Context>[]): (input: EvaluationInput<Context>) => Promise<Verdict> {
  return async input => {
    const results = await Promise.all(checks.map(check => check(input)));
    const findings = results.filter(finding => finding !== undefined);
    return verdictOf(findings);
  };
}

/** A verdict of the worst of `findings`. */
export function verdictOf(findings: Finding[]): Verdict {
  const health = worstHealth(findings.map(finding => finding.health));
  return { health, activity: 'active', findings };
}

/**
 * A verdict of something that isn't judged, and why: `idle` when nothing is asking for it, `off` when it is switched
 * off in the topology.
 */
export function inactive(activity: Exclude<Activity, 'active'>, check: string, summary: string): Verdict {
  return { health: 'unknown', activity, findings: [unknownFinding(check, summary)] };
}

/** A finding of nothing to judge by. */
export function unknownFinding(check: string, summary: string): Finding {
  return { check, health: 'unknown', summary, evidence: [] };
}

export interface HysteresisOptions {
  /** How many seconds a worse verdict must hold before the opinion takes it. 0 by default: at once. */
  worsenAfter?: number;
  /** How many seconds a better verdict must hold before the opinion takes it. */
  recoverAfter?: number;
}

/**
 * Take a verdict once it has held for long enough: a worse one after `worsenAfter` seconds, a better one after
 * `recoverAfter`. By time rather than by evaluations, since a reporter's monitors each submit on their own schedule, so
 * how often a subject is judged varies. A first opinion is taken as it is.
 */
export function hysteresis({ worsenAfter = 0, recoverAfter = 60 }: HysteresisOptions = {}): Settle {
  return (verdict, previous, at) => {
    // The same health as before holds, and clears any change seen. A different one is pending from when a change in
    // the same direction was first seen (unhealthy to degraded, then healthy, is one recovery), or from now; once
    // pending for long enough in its direction, it is taken.
    if (previous === undefined || verdict.health === previous.health)
      return { health: verdict.health, since: previous ? new Date(previous.state.since) : at, pending: null };
    const worsening = isWorse(verdict.health, previous.health);
    const pending = previous.state.pending;
    const sameWay = pending !== null && isWorse(pending.health, previous.health) === worsening;
    const held = sameWay ? new Date(pending.since) : at;
    const wait = worsening ? worsenAfter : recoverAfter;
    const heldFor = (at.getTime() - held.getTime()) / 1000;
    if (heldFor >= wait) return { health: verdict.health, since: at, pending: null };
    return {
      health: previous.health,
      since: new Date(previous.state.since),
      pending: { health: verdict.health, since: held.toISOString() }
    };
  };
}
