import { resolver, type GenerateSpecOptions } from 'hono-openapi';
import { ApiErrorSchema } from './schemas.ts';

export const specOptions = {
  documentation: {
    info: {
      title: 'Studio API',
      version: '0.1.0',
      description:
        'The conservation.tv studio API. Sign in through the Better Auth routes under `/auth`; the operations below ' +
        'run as the signed-in account, and the database shows each account only the rows it may see.'
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
