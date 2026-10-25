import { z } from 'zod';
import { ApiFailure } from '../errors.ts';

// The DNS zone gateway hostnames live in (src/gateways/certificates.ts), managed through Cloudflare's API with a token
// scoped to editing that zone's records. Records are never proxied: they name addresses on private networks, which
// Cloudflare could not reach anyway, and the point is that readers on the network reach the gateway directly.

const API = 'https://api.cloudflare.com/client/v4';

/** How long a record is cached, in seconds: short, so a gateway that moves to another agent is found again soon. */
const TTL_SECONDS = 60;

export type RecordType = 'A' | 'AAAA' | 'TXT';

export interface DnsZone {
  zoneId: string;
  token: string;
}

/** A record as it is written. */
interface RecordInput {
  type: RecordType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

/** A record as Cloudflare returns it. */
const DnsRecordSchema = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string() });
type DnsRecord = z.output<typeof DnsRecordSchema>;

/** What every response is wrapped in. */
const EnvelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z.unknown()
});
type Envelope = z.output<typeof EnvelopeSchema>;

/** One call to the zone's records, its result as `schema`; `gateway_unavailable` with what Cloudflare said when it refuses. */
async function call<Schema extends z.ZodType>(
  zone: DnsZone,
  method: string,
  path: string,
  schema: Schema,
  body?: RecordInput
): Promise<z.output<Schema>> {
  const response = await fetch(`${API}/zones/${zone.zoneId}/dns_records${path}`, {
    method,
    headers: { authorization: `Bearer ${zone.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const parsed = EnvelopeSchema.safeParse(await response.json().catch(() => undefined));
  const envelope: Envelope | undefined = parsed.success ? parsed.data : undefined;
  if (envelope?.success) return schema.parse(envelope.result);
  const reasons =
    envelope === undefined
      ? `${response.status} ${response.statusText}`
      : envelope.errors.map(error => `${error.code} ${error.message}`).join('; ');
  throw new ApiFailure('gateway_unavailable', { cause: `Cloudflare DNS refused ${method} ${path}: ${reasons}` });
}

/** The zone's records of the type at the name. */
function list(zone: DnsZone, type: RecordType, name: string): Promise<DnsRecord[]> {
  const query = new URLSearchParams({ type, name: name.toLowerCase() });
  return call(zone, 'GET', `?${query}`, z.array(DnsRecordSchema));
}

/** The one record of the type at the name, with this content: created, or updated in place, or left as it is. */
export async function upsertRecord(zone: DnsZone, type: RecordType, name: string, content: string): Promise<void> {
  const existing = await list(zone, type, name);
  const record: RecordInput = { type, name, content, ttl: TTL_SECONDS, proxied: false };
  const [first, ...rest] = existing;
  if (first === undefined) {
    await call(zone, 'POST', '', DnsRecordSchema, record);
    return;
  }
  if (first.content !== content) await call(zone, 'PUT', `/${first.id}`, DnsRecordSchema, record);
  // Only one record of the type should be at the name, so any others are leftovers.
  for (const extra of rest) await call(zone, 'DELETE', `/${extra.id}`, z.unknown());
}

/** A record of the type at the name, created beside any others there; returns how to remove it. */
export async function createRecord(zone: DnsZone, type: RecordType, name: string, content: string) {
  const record: RecordInput = { type, name, content, ttl: TTL_SECONDS, proxied: false };
  const created = await call(zone, 'POST', '', DnsRecordSchema, record);
  return () => call(zone, 'DELETE', `/${created.id}`, z.unknown()).then(() => undefined);
}
