import { z } from 'zod';

/** Every failure an API in this family renders: a stable category code and a fixed public description. */
export const ApiErrorSchema = z
  .object({
    error: z.string(),
    error_description: z.string()
  })
  .meta({ id: 'Error' });
export type ApiError = z.output<typeof ApiErrorSchema>;
