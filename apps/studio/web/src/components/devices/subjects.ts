// What agents report about the organisation's subjects under (`device:<id>`, `exposure:<id>`, and an output's
// `program:`, `forward:`, `preview:` and `recorder:`, as packages/reports names them). How each is doing is read once
// for the whole organisation, from its status (`organisations.status.get`, components/streams/topology.ts), never per
// subject.

/** What reports about a device (an agent, a camera) are filed under. */
export function deviceSubjectId(deviceId: string): string {
  return `device:${deviceId}`;
}

/** What reports about one of a stream's deliveries are filed under. */
export function exposureSubjectId(exposureId: string): string {
  return `exposure:${exposureId}`;
}

/** What an output's agent reports about its programme under: what OBS sends, and the program MediaMTX it goes to. */
export function programSubjectId(outputId: string): string {
  return `program:${outputId}`;
}

/** What an output's agent reports about one of its forwards to a channel under. */
export function forwardSubjectId(forwardId: string): string {
  return `forward:${forwardId}`;
}

/** What an output's agent reports about one of its previews at a gateway under. */
export function previewSubjectId(previewId: string): string {
  return `preview:${previewId}`;
}

/** What an output's agent reports about a channel it forwards to under: whether the platform has it live. */
export function channelSubjectId(channelId: string): string {
  return `channel:${channelId}`;
}

/** What an output's agent reports about its recording under. */
export function recorderSubjectId(recorderId: string): string {
  return `recorder:${recorderId}`;
}
