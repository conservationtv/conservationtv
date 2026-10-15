import { parseStrictJson } from '@conservationtv/versioned-api/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agentSigningKeys, logRecords, metricSamples, metricSeries, observations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { trusted, type Transaction } from '../organisations/membership.ts';
import { useServices } from '../services.ts';
import { MetricDimensionsSchema, SettingsSchema } from '../topology/settings.ts';
import { verifySignature } from './signatures.ts';
import { SubjectIdSchema } from './subjects.ts';

// Signed report ingestion: trusted code on the owning connection, because the signature, not a session, authenticates
// the reporter. Each submission names its key; the key must be registered and unrevoked, the signature must cover the
// report text exactly, and the key must belong to the reporting agent. Reports are stored in that agent's
// organisation, about whichever subject they name (src/reports/subjects.ts): which subjects an agent may report about
// is not restricted yet.
//
// A report's ID is unique per reporter: submitting the same report again is accepted as a duplicate and stores
// nothing, so agents can retry safely. Reports observed more than a little in the future are refused; ordering, late
// reports and their effect on state are the state consumer's concern.

/** How far ahead of the control plane's clock a report's observation time may be. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** A signed submission, as each ingestion endpoint receives it. */
export const SubmissionSchema = z.strictObject({
  keyId: z.uuid().describe('The registered signing key.'),
  report: z.string().min(2).max(65_536).describe('The report, as JSON text: the exact bytes that were signed.'),
  signature: z.string().min(1).max(128).describe("The key's Ed25519 signature of the report text, unpadded base64url.")
});
export type Submission = z.output<typeof SubmissionSchema>;

const reportOf = <Kind extends string, Payload extends z.ZodType>(kind: Kind, payload: Payload) =>
  z.strictObject({
    id: z.uuid(),
    kind: z.literal(kind),
    reporterId: z.uuid(),
    subjectId: SubjectIdSchema,
    observedAt: z.iso.datetime({ offset: true }),
    payload
  });

export const EventReportSchema = reportOf(
  'event',
  z.strictObject({ type: z.string().min(1).max(120), data: SettingsSchema.default({}) })
);
export type EventReport = z.output<typeof EventReportSchema>;

export const MetricReportSchema = reportOf(
  'metric',
  z.strictObject({
    name: z.string().min(1).max(200),
    type: z.enum(['gauge', 'counter']),
    value: z.number(),
    unit: z.string().min(1).max(60).nullable().default(null),
    dimensions: MetricDimensionsSchema.default({})
  })
);
export type MetricReport = z.output<typeof MetricReportSchema>;

export const LogReportSchema = reportOf(
  'log',
  z.strictObject({
    level: z.string().min(1).max(20),
    message: z.string().max(16_384),
    context: SettingsSchema.default({})
  })
);
export type LogReport = z.output<typeof LogReportSchema>;

/** The registered, unrevoked key that signed the submission, or `invalidSignature`. */
async function signingKey(tx: Transaction, submission: Submission) {
  const [key] = await tx
    .select({
      id: agentSigningKeys.id,
      organisationId: agentSigningKeys.organisationId,
      agentId: agentSigningKeys.agentId,
      publicKey: agentSigningKeys.publicKey,
      revokedAt: agentSigningKeys.revokedAt
    })
    .from(agentSigningKeys)
    .where(eq(agentSigningKeys.id, submission.keyId));
  // An unknown key, a revoked one and a wrong signature are indistinguishable to the submitter.
  if (
    !key ||
    key.revokedAt !== null ||
    !(await verifySignature(key.publicKey, submission.report, submission.signature))
  )
    throw new ApiFailure('invalid_signature');
  return key;
}

/** The signed report text as strict JSON (no duplicate members), for its kind's schema to parse. */
function reportJson(submission: Submission) {
  try {
    return parseStrictJson(submission.report);
  } catch (error) {
    throw new ApiFailure('invalid_report', { cause: error });
  }
}

/** Checks every parsed report passes: the key's agent is its reporter, and it was not observed in the future. */
function checkReport(report: EventReport | MetricReport | LogReport, agentId: string) {
  // The signature authenticates the key's agent, so the report must claim that agent as its reporter.
  if (report.reporterId !== agentId) throw new ApiFailure('invalid_signature');
  if (Date.parse(report.observedAt) > useServices().clock() + MAX_CLOCK_SKEW_MS) throw new ApiFailure('invalid_report');
}

/** Verify a submission's key and signature, then parse its report with its kind's schema. */
async function acceptEvent(tx: Transaction, submission: Submission) {
  const key = await signingKey(tx, submission);
  const parsed = EventReportSchema.safeParse(reportJson(submission));
  if (!parsed.success) throw new ApiFailure('invalid_report', { cause: parsed.error });
  checkReport(parsed.data, key.agentId);
  return { report: parsed.data, key };
}

async function acceptMetric(tx: Transaction, submission: Submission) {
  const key = await signingKey(tx, submission);
  const parsed = MetricReportSchema.safeParse(reportJson(submission));
  if (!parsed.success) throw new ApiFailure('invalid_report', { cause: parsed.error });
  checkReport(parsed.data, key.agentId);
  return { report: parsed.data, key };
}

async function acceptLog(tx: Transaction, submission: Submission) {
  const key = await signingKey(tx, submission);
  const parsed = LogReportSchema.safeParse(reportJson(submission));
  if (!parsed.success) throw new ApiFailure('invalid_report', { cause: parsed.error });
  checkReport(parsed.data, key.agentId);
  return { report: parsed.data, key };
}

/** Accept a signed event report into the event stream. */
export function ingestEvent(submission: Submission) {
  return trusted(async tx => {
    const { report, key } = await acceptEvent(tx, submission);
    const stored = await tx
      .insert(observations)
      .values({
        organisationId: key.organisationId,
        reporterId: report.reporterId,
        id: report.id,
        subjectId: report.subjectId,
        keyId: key.id,
        observedAt: new Date(report.observedAt),
        type: report.payload.type,
        data: report.payload.data
      })
      .onConflictDoNothing()
      .returning({ id: observations.id });
    return { id: report.id, duplicate: stored.length === 0 };
  });
}

/**
 * Accept a signed metric report as a sample of its series, creating the series on its first report. A series is its
 * subject, name, dimensions and reporter; its type and unit are fixed by the first report.
 */
export function ingestMetric(submission: Submission) {
  return trusted(async tx => {
    // Ensure the series exists, read it back to check the report agrees with its type and unit, then add the sample
    // unless this report ID was already stored.
    const { report, key } = await acceptMetric(tx, submission);
    const { name, type, unit, dimensions, value } = report.payload;
    await tx
      .insert(metricSeries)
      .values({
        organisationId: key.organisationId,
        subjectId: report.subjectId,
        reporterId: report.reporterId,
        name,
        type,
        unit,
        dimensions
      })
      .onConflictDoNothing();
    const [series] = await tx
      .select({ id: metricSeries.id, type: metricSeries.type, unit: metricSeries.unit })
      .from(metricSeries)
      .where(
        and(
          eq(metricSeries.subjectId, report.subjectId),
          eq(metricSeries.reporterId, report.reporterId),
          eq(metricSeries.name, name),
          eq(metricSeries.dimensions, dimensions)
        )
      );
    if (series!.type !== type || series!.unit !== unit) throw new ApiFailure('metric_series_conflict');
    const stored = await tx
      .insert(metricSamples)
      .values({
        organisationId: key.organisationId,
        reporterId: report.reporterId,
        reportId: report.id,
        seriesId: series!.id,
        keyId: key.id,
        observedAt: new Date(report.observedAt),
        value
      })
      .onConflictDoNothing()
      .returning({ reportId: metricSamples.reportId });
    return { id: report.id, duplicate: stored.length === 0 };
  });
}

/** Accept a signed log report. */
export function ingestLog(submission: Submission) {
  return trusted(async tx => {
    const { report, key } = await acceptLog(tx, submission);
    const stored = await tx
      .insert(logRecords)
      .values({
        organisationId: key.organisationId,
        reporterId: report.reporterId,
        id: report.id,
        subjectId: report.subjectId,
        keyId: key.id,
        observedAt: new Date(report.observedAt),
        level: report.payload.level,
        message: report.payload.message,
        context: report.payload.context
      })
      .onConflictDoNothing()
      .returning({ id: logRecords.id });
    return { id: report.id, duplicate: stored.length === 0 };
  });
}
