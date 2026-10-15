import { z } from 'zod';

// What a report is about, named by convention rather than stored: `<kind>:<id>` for a topology entity, such as
// `device:0199e8b2-…`, or `external:<name>` for something outside the topology, such as `external:https://example.org`.
// Reports join on the string as given, so entity IDs are lowercase, as the API returns them. Nothing checks that the
// entity exists or still does: reports about a deleted entity stay with the organisation that received them.

/** The topology entities a subject can name. */
export const SUBJECT_KINDS = ['network', 'device', 'agent', 'stream', 'exposure'] as const;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SUBJECT_ID = new RegExp(`^(?:(?:${SUBJECT_KINDS.join('|')}):${UUID}|external:\\S.{0,499})$`);

export const SubjectIdSchema = z
  .string()
  .regex(SUBJECT_ID)
  .describe(
    'What the report is about: `<kind>:<id>` for a network, device, agent, stream or exposure (lowercase ID), or `external:<name>` for anything else.'
  );
export type SubjectId = z.output<typeof SubjectIdSchema>;
