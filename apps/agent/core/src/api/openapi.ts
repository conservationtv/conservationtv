import { resolver, type GenerateSpecOptions } from 'hono-openapi';
import { ApiErrorSchema } from './schemas.ts';

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
