import type { MetricDimensions } from '@conservationtv/reports';

// The words the state consumer judges a subject in (src/health/consumer.ts), from least to most severe once known:
// `healthy`, `degraded` (working, but not as it should: dropping frames, on the offline segment), `unhealthy` (not
// doing its job). `unknown` is having nothing to judge by, which never outweighs a judgement. Whether a subject is
// still reporting at all is its freshness, evaluated when read, not its health.
//
// Health is only a judgement of something that is meant to be working now. Whether it is, is its activity: `active`
// (expected to be doing its job, so judged), `idle` (on, but nothing is asking for it: an on-demand path nobody reads, a
// relay nobody watches) or `off` (switched off in the topology: a disabled forward or camera). What is idle or off
// isn't judged, so its health is `unknown`, and it never counts as a problem.

/** The locale findings' summaries are written in: they are English sentences, so their numbers are too. */
export const FINDINGS_LOCALE = 'en';

export const HEALTHS = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export type Health = (typeof HEALTHS)[number];

export const ACTIVITIES = ['active', 'idle', 'off'] as const;
export type Activity = (typeof ACTIVITIES)[number];

const LIVELINESS = { off: 0, idle: 1, active: 2 } satisfies Record<Activity, number>;

/** The most active of `activities`: one part being asked for is the whole being asked for. `off` when there are none. */
export function mostActive(activities: Iterable<Activity>): Activity {
  let most: Activity = 'off';
  for (const activity of activities) if (LIVELINESS[activity] > LIVELINESS[most]) most = activity;
  return most;
}

const SEVERITY = { unknown: 0, healthy: 1, degraded: 2, unhealthy: 3 } satisfies Record<Health, number>;

/** Whether `a` is worse than `b`. */
export function isWorse(a: Health, b: Health): boolean {
  return SEVERITY[a] > SEVERITY[b];
}

/** The worst of `healths`: `unknown` only when none is known, and when there are none. */
export function worstHealth(healths: Iterable<Health>): Health {
  let worst: Health = 'unknown';
  for (const health of healths) if (isWorse(health, worst)) worst = health;
  return worst;
}

/** One series' value that a finding rests on. */
export interface Evidence {
  seriesId: string;
  dimensions: MetricDimensions;
  value: number;
}

/** One check's judgement of a subject, and why: what an opinion's health is made of. */
export interface Finding {
  /** What was checked, such as a metric's name. */
  check: string;
  health: Health;
  /** The judgement in words, for people: `Ready 62% of the last 2 min`. */
  summary: string;
  evidence: Evidence[];
}

/** A metric the evaluation read: what an opinion was formed from, whatever its findings cite. */
export interface Consulted {
  metric: string;
  /** The seconds back it was read `over`. */
  read: number;
  seriesIds: string[];
}

/** A change of health an evaluator has seen but not yet settled on (src/health/evaluator.ts, `hysteresis`). */
export interface PendingHealth {
  health: Health;
  /** ISO 8601: when the evaluation first came to it. */
  since: string;
}

/** What a reporter's opinion of a subject keeps beside its health: why, and what it was formed from. */
export interface OpinionState {
  findings: Finding[];
  consulted: Consulted[];
  /** ISO 8601: since when the opinion has held its health. */
  since: string;
  pending: PendingHealth | null;
}

/** A finding as a subject's combined state keeps it: whose opinion it came from. */
export interface ReportedFinding extends Finding {
  reporterId: string;
}

/** What a subject's combined state keeps beside its health: the findings of the opinions it was combined from. */
export interface SubjectHealthState {
  findings: ReportedFinding[];
}
