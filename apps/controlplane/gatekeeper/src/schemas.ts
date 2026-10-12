import { z } from 'zod';

// Only shared response components live here. Each route declares its input schema inline.
export const ApiErrorSchema = z
  .object({
    error: z.string(),
    error_description: z.string()
  })
  .meta({ id: 'Error' });
export type ApiError = z.output<typeof ApiErrorSchema>;
