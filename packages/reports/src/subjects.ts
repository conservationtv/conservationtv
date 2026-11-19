import { z } from 'zod';

// What a report is about, and who reported it, named by one convention rather than stored: `<kind>:<id>` for a topology
// entity, such as `device:0199e8b2-…`, or `external:<name>` for something outside the topology, such as
// `external:https://example.org`. A reporter is always the signing device, `device:<id>`. Reports join on the strings as
// given, so entity IDs are lowercase, as the API returns them. Nothing checks that the entity exists or still does:
// reports by or about a deleted entity stay with the organisation that received them.

/** The topology entities a subject can name. */
export const SUBJECT_KINDS = [
  'network',
  'device',
  'agent',
  'stream',
  'exposure',
  'program',
  'forward',
  'preview',
  'recorder',
  'channel'
] as const;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SUBJECT_ID = new RegExp(`^(?:(?:${SUBJECT_KINDS.join('|')}):${UUID}|external:\\S.{0,499})$`);

export const SubjectIdSchema = z
  .string()
  .regex(SUBJECT_ID)
  .describe(
    "What the report is about: `<kind>:<id>` for a network, device, agent, stream or exposure, an output's programme (by the output's ID), one of its forwards, previews or recorders, or a channel it goes out to (lowercase ID), or `external:<name>` for anything else."
  );
export type SubjectId = z.output<typeof SubjectIdSchema>;

/** A device, as a subject or a reporter. */
export const deviceSubject = (deviceId: string): SubjectId => `device:${deviceId}`;

/** An exposure, as a subject: what the paths delivering it report about. */
export const exposureSubject = (exposureId: string): SubjectId => `exposure:${exposureId}`;

/** An output's programme, as a subject: what its agent reports about what OBS sends out. */
export const programSubject = (outputId: string): SubjectId => `program:${outputId}`;

/** An output's forward to a channel, as a subject. */
export const forwardSubject = (forwardId: string): SubjectId => `forward:${forwardId}`;

/** An output's preview, as a subject. */
export const previewSubject = (previewId: string): SubjectId => `preview:${previewId}`;

/** An output's recorder, as a subject. */
export const recorderSubject = (recorderId: string): SubjectId => `recorder:${recorderId}`;

/** A channel an output goes out to, as a subject: what its platform says of it, as the output's agent reads it. */
export const channelSubject = (channelId: string): SubjectId => `channel:${channelId}`;
