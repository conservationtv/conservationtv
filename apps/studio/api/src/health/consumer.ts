import { and, eq, sql } from 'drizzle-orm';
import { reporterOpinions, subjectStates, subjectTransitions } from '../db/schema.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { traced } from '../tracing/trace.ts';
import { type Evaluator, formOpinion, type Subject } from './evaluator.ts';
import { evaluatorOf } from './evaluators.ts';
import { type Health, mostActive, type ReportedFinding, worstHealth } from './health.ts';
import { subjectMetrics } from './metrics.ts';

// The state consumer: after a batch is stored (src/reports/ingest.ts), each subject its metrics are about is judged
// again by its kind's evaluator (src/health/evaluators.ts), as the reporter's opinion of it, and the opinions of all
// its reporters are combined into its state. It judges from what is stored, not from the batch, so judging a subject
// again is harmless: a failed evaluation is put right by the next batch, and one of a late batch, older than the
// opinion it would replace, is skipped.
//
// Each subject is judged in a trusted transaction of its own, holding a lock on the subject for the transaction, so
// two reporters' batches about one subject combine one after the other. A subject whose kind isn't judged by its own
// reports, or that names something outside the topology, is left alone. Each judgement is a `health.evaluate` span in
// the request's trace, with the subject, and what the reporter's opinion and the subject's state became.

/** A judgement skipped: the reporter's opinion already rests on newer reports. */
interface LateEvaluation {
  late: true;
}

/** A judgement made: the reporter's opinion before and now, and the subject's state now. */
interface FormedEvaluation {
  late: false;
  previous?: Health;
  opinion: Health;
  /** Undefined only if no opinion of the subject was there to combine. */
  state?: Health;
}

/** What judging a subject again came to. */
type Evaluation = LateEvaluation | FormedEvaluation;

/** What a batch reported metrics about: each subject, as of its newest report. */
export interface Reported {
  organisationId: string;
  reporterId: string;
  subjects: Map<string, Date>;
}

/** Judge each reported subject again, and combine its state. A subject that fails to is logged, and the rest go on. */
export async function evaluateReported({ organisationId, reporterId, subjects }: Reported) {
  for (const [subjectId, at] of subjects) {
    const evaluator = evaluatorOf(subjectId);
    if (evaluator === null) continue;
    const entityId = subjectId.slice(subjectId.indexOf(':') + 1);
    const subject: Subject = { organisationId, subjectId, entityId, reporterId, at };
    try {
      await traced(
        'health.evaluate',
        { 'studio.subject.id': subjectId, 'studio.subject.kind': subjectId.slice(0, subjectId.indexOf(':')) },
        async span => {
          const evaluation = await trustedTransaction(() => evaluateSubject(evaluator, subject));
          span.setAttributes(evaluationAttributes(evaluation));
        }
      );
    } catch (error) {
      console.warn(JSON.stringify({ event: 'subject_evaluation_failed', subjectId, reporterId, cause: String(error) }));
    }
  }
}

/** What a judgement came to, as its span's attributes. */
function evaluationAttributes(evaluation: Evaluation) {
  if (evaluation.late) return { 'studio.health.late': true };
  return {
    'studio.health.late': false,
    'studio.health.opinion.previous': evaluation.previous,
    'studio.health.opinion': evaluation.opinion,
    'studio.health.state': evaluation.state
  };
}

async function evaluateSubject(evaluator: Evaluator, subject: Subject): Promise<Evaluation> {
  const db = useDB({ trusted: true });
  const { organisationId, subjectId, reporterId, at } = subject;
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${organisationId}/${subjectId}`}, 0))`);

  const [previous] = await db
    .select({
      health: reporterOpinions.health,
      activity: reporterOpinions.activity,
      state: reporterOpinions.state,
      observedAt: reporterOpinions.observedAt
    })
    .from(reporterOpinions)
    .where(
      and(
        eq(reporterOpinions.organisationId, organisationId),
        eq(reporterOpinions.subjectId, subjectId),
        eq(reporterOpinions.reporterId, reporterId)
      )
    );
  // A late batch: the opinion already rests on newer reports.
  if (previous !== undefined && previous.observedAt > at) return { late: true };

  const context = await evaluator.context(subject);
  const { metrics, consulted } = subjectMetrics(subject);
  const formed = await formOpinion(evaluator, { subject, metrics, context, previous }, consulted);
  const opinion = { ...formed, evidenceReportIds: [] };
  await db
    .insert(reporterOpinions)
    .values({ organisationId, subjectId, reporterId, ...opinion })
    .onConflictDoUpdate({ target: [reporterOpinions.subjectId, reporterOpinions.reporterId], set: opinion });

  const state = await combine(organisationId, subjectId);
  return { late: false, previous: previous?.health, opinion: opinion.health, state };
}

/**
 * The subject's state from its reporters' opinions: of those still fresh, the most active's activity, and the worst
 * health of those that judged it (the `active` ones), with their findings. When none is fresh, the subject keeps what
 * it had, and goes stale with the newest of them. A state that differs in health or activity from the one before is a
 * transition, kept (`subject_transition`).
 */
async function combine(organisationId: string, subjectId: string): Promise<Health | undefined> {
  const db = useDB({ trusted: true });
  const environment = useEnvironment();
  const now = new Date(environment.clock());
  const opinions = await db
    .select({
      reporterId: reporterOpinions.reporterId,
      health: reporterOpinions.health,
      activity: reporterOpinions.activity,
      state: reporterOpinions.state,
      observedAt: reporterOpinions.observedAt,
      expiresAt: reporterOpinions.expiresAt
    })
    .from(reporterOpinions)
    .where(and(eq(reporterOpinions.organisationId, organisationId), eq(reporterOpinions.subjectId, subjectId)))
    .orderBy(reporterOpinions.reporterId);
  if (opinions.length === 0) return undefined;

  const fresh = opinions.filter(opinion => opinion.expiresAt > now);
  const reporting = fresh.length > 0 ? fresh : opinions;
  // One reporter that is asked for it judges it, whatever another finds idle: only those opinions are of its health.
  const activity = mostActive(reporting.map(opinion => opinion.activity));
  const contributing = reporting.filter(opinion => opinion.activity === activity);
  const health = worstHealth(contributing.map(opinion => opinion.health));
  // What couldn't be judged, such as a relay that isn't published to, only says something when nothing could be.
  const findings: ReportedFinding[] = contributing.flatMap(({ reporterId, state }) =>
    state.findings
      .filter(finding => health === 'unknown' || finding.health !== 'unknown')
      .map(finding => ({ ...finding, reporterId }))
  );
  const observedAt = new Date(Math.max(...contributing.map(opinion => opinion.observedAt.getTime())));
  const expiresAt = new Date(Math.max(...contributing.map(opinion => opinion.expiresAt.getTime())));
  const state = {
    health,
    activity,
    state: { findings },
    observedAt,
    expiresAt,
    computedAt: now,
    contributingReporterIds: contributing.map(opinion => opinion.reporterId),
    evidenceReportIds: []
  };
  const [before] = await db
    .select({ health: subjectStates.health, activity: subjectStates.activity })
    .from(subjectStates)
    .where(and(eq(subjectStates.organisationId, organisationId), eq(subjectStates.subjectId, subjectId)));
  if (before === undefined || before.health !== health || before.activity !== activity) {
    // A first state, or one that differs in health or activity from the one before, is a transition.
    await db.insert(subjectTransitions).values({
      organisationId,
      subjectId,
      at: observedAt,
      health,
      activity,
      previousHealth: before?.health ?? null,
      previousActivity: before?.activity ?? null,
      findings
    });
  }
  await db
    .insert(subjectStates)
    .values({ organisationId, subjectId, ...state })
    .onConflictDoUpdate({ target: [subjectStates.organisationId, subjectStates.subjectId], set: state });
  return health;
}
