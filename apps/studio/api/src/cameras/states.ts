/**
 * Whether a camera feeds its streams: only an `enabled` one does. `locked` and `disabled` both stop it, for now
 * meaning the same to the planner (src/configuration/plan/index.ts).
 */
export const CAMERA_STATES = ['enabled', 'locked', 'disabled'] as const;
export type CameraState = (typeof CAMERA_STATES)[number];
