import { CameraFailure, UnsupportedCommand } from '@conservationtv/cameras/control';
import { NotMutating } from '@conservationtv/converge';
import { apiError, createErrorHandler } from '@conservationtv/versioned-api/server';
import { z } from 'zod';
import { CameraHeld, GrantRefused, UnknownCamera } from '../cameras/index.ts';

export { handleNotFound } from '@conservationtv/versioned-api/server';

/** A change the spec can't take as it stands, such as a path for a MediaMTX that isn't running. */
export class SpecConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecConflict';
  }
}

/** What each failure of the camera routes is answered as: its code, and its status. */
const CAMERA_FAILURES = [
  [UnknownCamera, 'not_found', 404],
  [GrantRefused, 'grant_refused', 403],
  [CameraHeld, 'camera_held', 409],
  [UnsupportedCommand, 'unsupported_command', 422],
  [CameraFailure, 'camera_failed', 502]
] as const;

/**
 * What the agent's cameras turn away, and changes to the spec the agent turns away, first; the common handler renders
 * routing, version and validation failures. Only a change to the spec parses it outside a validator, so a `ZodError`
 * is a change that would leave it invalid.
 */
export const handleError = createErrorHandler((error, c) => {
  // The agent's own failures, each by its class; anything else is the common handler's.
  if (error instanceof NotMutating)
    return apiError(c, 'not_configurable', 'This agent is configured by the studio, not over this API.', 409);
  if (error instanceof SpecConflict) return apiError(c, 'conflict', error.message, 409);
  const camera = CAMERA_FAILURES.find(([failure]) => error instanceof failure);
  if (camera !== undefined) return apiError(c, camera[1], error.message, camera[2]);
  if (error instanceof z.ZodError) return apiError(c, 'invalid_spec', z.prettifyError(error), 422);
  return undefined;
});
