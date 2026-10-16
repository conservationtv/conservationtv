import { parseStrictJson } from '@conservationtv/versioned-api/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents, devices, logRecords, metricSamples, observations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { trusted, type Transaction } from '../organisations/membership.ts';
import { useServices } from '../services.ts';
import { MetricDimensionsSchema, SettingsSchema } from '../topology/settings.ts';
import { verifySignature } from './signatures.ts';
import { SubjectIdSchema } from './subjects.ts';

// Signed report ingestion: trusted code on the owning connection, because the signature, not a session, authenticates
// the reporter. An agent is a device (src/db/schemas/agents.ts), and sends its reports in batches, each signed once with
// its identity: the submission names the agent by its public ID, and the signature must cover the batch text exactly
// under its public key. Reports are stored in the agent's organisation, about whichever subject they name
// (src/reports/subjects.ts): which subjects an agent may report about is not restricted yet.
//
// A batch is accepted or refused whole, and only for trust or shape: a bad signature, a signer that is not an agent, a
// malformed report or one observed in the future. Everything else is stored as given. Reports are cheap operational signals, so
// nothing deduplicates them: an agent that retries a batch may store it twice. Ordering, late reports and their effect
// on state are the state consumer's concern.

/** How far ahead of the control plane's clock a report's observation time may be. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The most reports one batch may carry. */
export const MAX_BATCH_REPORTS = 1000;

/** A signed batch, as the ingestion endpoint receives it. */
export const SubmissionSchema = z.strictObject({
  publicId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe("The reporting agent's public ID, which identifies its key."),
  batch: z.string().min(2).describe('The batch, as JSON text: the exact bytes that were signed.'),
  signature: z.string().min(1).max(128).describe("The agent's Ed25519 signature of the batch text, unpadded base64url.")
});
export type Submission = z.output<typeof SubmissionSchema>;

const reportOf = <Kind extends string, Payload extends z.ZodType>(kind: Kind, payload: Payload) =>
  z.strictObject({
    kind: z.literal(kind),
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

/** The signed batch: one agent's reports, of any kinds and subjects. */
export const BatchSchema = z.strictObject({
  reports: z
    .array(z.discriminatedUnion('kind', [EventReportSchema, MetricReportSchema, LogReportSchema]))
    .min(1)
    .max(MAX_BATCH_REPORTS)
});
export type Batch = z.output<typeof BatchSchema>;

/** The agent whose identity signed the submission, or `invalidSignature`. */
async function signer(tx: Transaction, submission: Submission) {
  const [agent] = await tx
    .select({ id: agents.id, organisationId: agents.organisationId, publicKey: devices.publicKey })
    .from(agents)
    .innerJoin(devices, eq(devices.id, agents.id))
    .where(eq(devices.publicId, submission.publicId));
  // An unknown device, a device that is not an agent and a wrong signature are indistinguishable to the submitter.
  if (!agent || !(await verifySignature(agent.publicKey, submission.batch, submission.signature)))
    throw new ApiFailure('invalid_signature');
  return agent;
}

/** The signed batch text as strict JSON (no duplicate members), for the batch schema to parse. */
function batchJson(submission: Submission) {
  try {
    return parseStrictJson(submission.batch);
  } catch (error) {
    throw new ApiFailure('invalid_report', { cause: error });
  }
}

/** The signed batch, parsed with the batch schema. */
function parseBatch(submission: Submission) {
  const parsed = BatchSchema.safeParse(batchJson(submission));
  if (!parsed.success) throw new ApiFailure('invalid_report', { cause: parsed.error });
  return parsed.data;
}

/** Verify a submission's signer and signature, then store every report in its batch. */
export function ingestBatch(submission: Submission) {
  return trusted(async tx => {
    // Authenticate first, so nothing about an unsigned batch is parsed; then refuse it whole if any report is from the
    // future, and otherwise store each kind of report with one insert.
    const agent = await signer(tx, submission);
    const batch = parseBatch(submission);
    const services = useServices();
    const now = services.clock();
    if (batch.reports.some(report => Date.parse(report.observedAt) > now + MAX_CLOCK_SKEW_MS))
      throw new ApiFailure('invalid_report');

    const reported = (report: EventReport | MetricReport | LogReport) => ({
      organisationId: agent.organisationId,
      reporterId: agent.id,
      subjectId: report.subjectId,
      observedAt: new Date(report.observedAt)
    });
    const events = batch.reports.filter(report => report.kind === 'event');
    const metrics = batch.reports.filter(report => report.kind === 'metric');
    const logs = batch.reports.filter(report => report.kind === 'log');
    if (events.length > 0)
      await tx
        .insert(observations)
        .values(events.map(report => ({ ...reported(report), type: report.payload.type, data: report.payload.data })));
    if (metrics.length > 0)
      await tx.insert(metricSamples).values(metrics.map(report => ({ ...reported(report), ...report.payload })));
    if (logs.length > 0)
      await tx.insert(logRecords).values(logs.map(report => ({ ...reported(report), ...report.payload })));
    return { accepted: batch.reports.length };
  });
}
