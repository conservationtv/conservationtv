import type { State } from '@conservationtv/studio-sdk';

// What agents report about the organisation's subjects (`device:<id>`, `exposure:<id>`), as pages look it up while
// rendering: read once for the whole organisation (subjectStateListQueryOptions), never per subject.

/** What reports about a device (an agent, a camera) are filed under. */
export function deviceSubjectId(deviceId: string): string {
  return `device:${deviceId}`;
}

/** What reports about one of a stream's deliveries are filed under. */
export function exposureSubjectId(exposureId: string): string {
  return `exposure:${exposureId}`;
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
  return 'Healthy';
}
