import { z } from 'zod';
import { CameraCommandSchema, type CameraCommand } from './contract.ts';

// What admits a command to a camera: a grant the studio API signs, which the agent that reaches the camera checks on
// its own. Being able to connect to an agent is not being allowed to move its cameras: every command carries a grant
// saying which camera, what may be done to it, and for whom.
//
// A grant is a JWT signed with the identity of the agent serving the camera, which the studio API holds, as a MediaMTX
// gateway's tokens are: the agent verifies it against its own public key, with nothing to fetch. It is issued by the
// studio API (`iss`), for that agent's endpoint ID (`aud`), to the endpoint ID of the device that will present it
// (`sub`), which the agent checks against the peer the connection authenticated: a copied grant is of no use to
// anyone else. Its `camera_grant` claim is below.

/** The claim a grant's scope is carried in. */
export const CAMERA_GRANT_CLAIM = 'camera_grant';

/** The header a command's grant is presented in. */
export const CAMERA_GRANT_HEADER = 'Camera-Grant';

/** How grants are signed: by the serving agent's Ed25519 identity, as JOSE names it. */
export const CAMERA_GRANT_ALGORITHM = 'EdDSA';

/**
 * Whose command it is, when two would move the same camera: an `operator`, a person at the controls, takes it from
 * `automation` (a chat command, say), whose commands are turned away while an operator holds it.
 */
export const CAMERA_GRANT_PRIORITIES = ['operator', 'automation'] as const;
export type CameraGrantPriority = (typeof CAMERA_GRANT_PRIORITIES)[number];

/**
 * What a grant admits: `control`, any command until it expires, for a person's session at the controls; or `command`,
 * exactly that command, once, as a chat command is resolved to.
 */
const CameraGrantScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('control') }),
  z.strictObject({ kind: z.literal('command'), command: CameraCommandSchema })
]);
export type CameraGrantScope = z.output<typeof CameraGrantScopeSchema>;

export const CameraGrantSchema = z.strictObject({
  cameraId: z.uuid(),
  scope: CameraGrantScopeSchema,
  priority: z.enum(CAMERA_GRANT_PRIORITIES)
});
export type CameraGrant = z.output<typeof CameraGrantSchema>;

/** The command with its members in a fixed order, so two that say the same compare equal however they were written. */
function canonical(command: CameraCommand): string {
  const members = Object.entries(command).filter(([, value]) => value !== undefined);
  return JSON.stringify(members.toSorted(([a], [b]) => a.localeCompare(b)));
}

/** Whether the grant admits the command. */
export function admits(grant: CameraGrant, command: CameraCommand): boolean {
  if (grant.scope.kind === 'control') return true;
  return canonical(grant.scope.command) === canonical(command);
}
