import { errorResponse } from '@conservationtv/versioned-api/server';
import { resolver, type GenerateSpecOptions } from 'hono-openapi';
import { ApiErrorSchema } from './schemas.ts';

// The agent API's descriptions of its failure responses.
export const invalidRequest = errorResponse('The request is malformed');
export const unknownCamera = errorResponse('The agent controls no such camera: it is not one of its cameras, or not enabled');
export const grantRefused = errorResponse('No grant was presented, or it does not admit this command to this camera from this peer');
export const cameraHeld = errorResponse("Someone else is at the camera's controls");
export const unsupportedCommand = errorResponse('The camera cannot do that');
export const cameraFailed = errorResponse('The camera did not answer, or refused');

export const specOptions = {
  documentation: {
    info: {
      title: 'Agent API',
      version: '0.1.0',
      description: 'The conservation.tv agent API, served by the agent itself.'
    },
    components: {
      responses: {
        InvalidRequest: {
          description: 'The request is invalid',
          content: { 'application/json': { schema: resolver(ApiErrorSchema) } }
        }
      }
    }
  },
  defaultValidationErrorResponse: {
    description: 'The request is invalid',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
  }
} satisfies Partial<GenerateSpecOptions>;
