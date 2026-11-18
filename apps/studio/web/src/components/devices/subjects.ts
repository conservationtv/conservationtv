import type { State } from '@conservationtv/studio-sdk';

// What agents report about the organisation's subjects (`device:<id>`, `exposure:<id>`, and a show's `program:`,
// `forward:`, `preview:` and `recorder:`, as packages/reports names them), as pages look it up while
// rendering: read once for the whole organisation (subjectStateListQueryOptions), never per subject.

/** What reports about a device (an agent, a camera) are filed under. */
export function deviceSubjectId(deviceId: string): string {
  return `device:${deviceId}`;
}

/** What reports about one of a stream's deliveries are filed under. */
export function exposureSubjectId(exposureId: string): string {
  return `exposure:${exposureId}`;
}

/** What a show's output reports about its programme under: what OBS sends, and the program MediaMTX it goes to. */
export function programSubjectId(showId: string): string {
  return `program:${showId}`;
}

/** What a show's output reports about one of its forwards to a channel under. */
export function forwardSubjectId(forwardId: string): string {
  return `forward:${forwardId}`;
}

/** What a show's output reports about one of its previews at a gateway under. */
export function previewSubjectId(previewId: string): string {
  return `preview:${previewId}`;
}

/** What a show's output reports about a channel it forwards to under: whether the platform has it live. */
export function channelSubjectId(channelId: string): string {
  return `channel:${channelId}`;
}

/** What a show's output reports about its recording under. */
export function recorderSubjectId(recorderId: string): string {
  return `recorder:${recorderId}`;
}

/** What agents last said about one subject, combined. */
export type SubjectState = State['states'][number];

/** Each subject's state, by its subject ID. */
export function statesBySubject(states: SubjectState[]): Map<string, SubjectState> {
  return new Map(states.map(state => [state.subjectId, state]));
}

/** How a subject is doing, in a word or two: what its status dot means. */
export function healthOf(state: SubjectState | undefined): string {
  if (!state) return 'No reports';
  if (state.freshness === 'stale') return 'Gone quiet';
  if (state.health === 'unhealthy') return 'Unhealthy';
  if (state.health === 'degraded') return 'Degraded';
  if (state.health === 'unknown') return 'Nothing to judge';
  return 'Healthy';
}

/**
 * Why the subject is as it is, a line for each of the state consumer's findings that isn't healthy: `Ready 62% of the
 * last 2 min`. Undefined when there are none.
 */
export function reasonsOf(state: SubjectState | undefined): string | undefined {
  const findings = state?.state.findings ?? [];
  const reasons = findings.filter(finding => finding.health !== 'healthy').map(finding => finding.summary);
  if (reasons.length === 0) return undefined;
  return reasons.join('\n');
}
