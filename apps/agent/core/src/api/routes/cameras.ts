import { CAMERA_GRANT_HEADER, CameraCommandSchema } from '@conservationtv/cameras';
import { operationVersion, validator, versionMismatch } from '@conservationtv/versioned-api/server';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { eventStream } from '../../cameras/events.ts';
import { useCameraControl, verifyGrant } from '../../cameras/index.ts';
import type { AgentEnv } from '../app.ts';
import { cameraFailed, cameraHeld, grantRefused, invalidRequest, unknownCamera, unsupportedCommand } from '../openapi.ts';

// The agent's cameras, controlled by the contract every kind of camera shares (`@conservationtv/cameras`): what each
// can do, where it points, and the commands it takes. Any peer the agent serves may look; a command needs a grant the
// studio API signed for the peer sending it (`organisations.cameras.control.connect`, or a chat command's), presented
// in the `Camera-Grant` header, which says what may be done to which camera.

const CameraParamsSchema = z.object({ cameraId: z.uuid().describe('The camera.') });
export type CameraParams = z.output<typeof CameraParamsSchema>;

export default new Hono<AgentEnv>()
  .get(
    '/',
    describeRoute({
      operationId: 'cameras.list',
      ...operationVersion(1),
      summary: 'List the cameras the agent controls',
      description:
        'Each camera the studio gave the agent that is `enabled`, by its ID there, with its `capabilities`: the `moves` it takes, how far it pans and tilts in degrees, whether it zooms and focuses, the `options` it has with the values each takes, and the `actions` it runs. A camera that cannot move lists no moves. `capabilities` is null while the camera has not answered.',
      responses: { 200: { description: 'The cameras' }, 412: versionMismatch }
    }),
    async c => {
      const control = useCameraControl();
      const cameras = await control.list();
      c.header('Cache-Control', 'no-store');
      return c.json({ cameras }, 200);
    }
  )
  .get(
    '/:cameraId/state',
    describeRoute({
      operationId: 'cameras.state.get',
      ...operationVersion(1),
      summary: 'Read where a camera points',
      description:
        'Asked of the camera now: its `position` on each axis it has (`pan` and `tilt` in degrees, `zoom` and `focus` as fractions of its range), what its `options` are set to, and its `holder`, the peer at its controls and until when unless they go on, or null.',
      responses: {
        200: { description: "The camera's state" },
        400: invalidRequest,
        404: unknownCamera,
        412: versionMismatch,
        502: cameraFailed
      }
    }),
    validator('param', CameraParamsSchema),
    async c => {
      const { cameraId } = c.req.valid('param');
      const control = useCameraControl();
      const state = await control.state(cameraId);
      c.header('Cache-Control', 'no-store');
      return c.json(state, 200);
    }
  )
  .post(
    '/:cameraId/commands',
    describeRoute({
      operationId: 'cameras.commands.run',
      ...operationVersion(1),
      summary: 'Send a camera a command',
      description:
        "Carries out one `command` its grant admits. The grant, in the `Camera-Grant` header, is a JWT the studio API signed with this agent's identity, for this agent, to the peer sending it: `grant_refused` (403) without one, or when it is another device's, another camera's, expired, admits only a different command, or admits one command and has been used. A person's grant admits any command while it lasts, and takes the camera for a few seconds after each: `camera_held` (409) turns away automation, such as a chat command, while someone else holds it. `drive` keeps the camera moving only while it is repeated: the agent stops a camera that isn't driven again within a second or so. `unsupported_command` (422) for a move the camera's capabilities don't list, and `camera_failed` (502) when the camera doesn't answer or refuses.",
      responses: {
        204: { description: 'Done' },
        400: invalidRequest,
        403: grantRefused,
        404: unknownCamera,
        409: cameraHeld,
        412: versionMismatch,
        422: unsupportedCommand,
        502: cameraFailed
      }
    }),
    validator('param', CameraParamsSchema),
    validator('json', z.strictObject({ command: CameraCommandSchema })),
    async c => {
      const { cameraId } = c.req.valid('param');
      const { command } = c.req.valid('json');
      const control = useCameraControl();
      const { peer, identity } = c.env;
      const check = { issuer: control.grantIssuer, identity, peer };
      const admitted = await verifyGrant(c.req.header(CAMERA_GRANT_HEADER), check);
      await control.run(cameraId, command, admitted);
      return c.body(null, 204);
    }
  )
  .get(
    '/:cameraId/events',
    describeRoute({
      operationId: 'cameras.events',
      ...operationVersion(1),
      summary: "Follow a camera's state",
      description:
        'A `text/event-stream` of the camera’s state, as `cameras.state.get` gives it: a `state` event at once, and another each time its position, its options or its holder changes, with a `ping` when nothing has for a while. The stream ends after ten minutes, or when the camera is no longer controlled here: ask again to keep following.',
      responses: {
        200: { description: 'The events', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        400: invalidRequest,
        404: unknownCamera,
        412: versionMismatch
      }
    }),
    validator('param', CameraParamsSchema),
    c => {
      const { cameraId } = c.req.valid('param');
      const control = useCameraControl();
      const states = control.watch(cameraId);
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-store');
      return c.body(eventStream(states), 200);
    }
  );
