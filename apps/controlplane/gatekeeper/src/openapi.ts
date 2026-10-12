import { resolver, type GenerateSpecOptions } from 'hono-openapi';
import { ApiErrorSchema } from './schemas.ts';

export const specOptions = {
  documentation: {
    info: {
      title: 'Gatekeeper',
      version: '0.1.0',
      description:
        'The conservation.stream control plane: a relay capability broker that exchanges consumer-signed grant ' +
        'assertions for MoQ and Iroh relay credentials.'
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
