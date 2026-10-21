import { z } from 'zod';

export const GrantExchangeResultSchema = z.strictObject({
  grant_id: z.string(),
  subject: z.string(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  credentials: z.strictObject({
    moq: z
      .strictObject({ relay: z.url(), root: z.string(), token: z.string(), expires_at: z.iso.datetime() })
      .optional(),
    iroh: z
      .strictObject({ relay: z.url(), endpoint_id: z.string(), lease_id: z.string(), expires_at: z.iso.datetime() })
      .optional()
  })
});
export type GrantExchangeResult = z.output<typeof GrantExchangeResultSchema>;
