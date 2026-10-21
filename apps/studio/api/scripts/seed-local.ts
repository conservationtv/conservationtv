import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { LOCAL_ADMIN_DATABASE_URL } from '../src/db/local.ts';

// Seeds the local database with a topology to try delivery against: an organisation with one network, its active
// agent running a MediaMTX gateway, an Axis camera, and a stream from it exposed on the LAN at every rendition and to
// the conservation.tv relay at two. Everything but the account is made through the running API (`pnpm dev`), as
// administrators would, so it is checked as their changes are.
//
//   SEED_EMAIL=you@example.com SEED_CAMERA_HOST=http://192.168.1.10 SEED_CAMERA_USERNAME=root \
//     SEED_CAMERA_PASSWORD=… pnpm db:seed
//
// The account is the one `SEED_EMAIL` signs in as (by emailed code, as ever), made here with a session the script
// uses as its bearer token. The camera's credentials go to the API, which keeps them encrypted; nothing is written to
// disk. Prints what the agent needs to act as its device.

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Set ${name}`);
  return value;
};

const email = required('SEED_EMAIL');
const cameraHost = required('SEED_CAMERA_HOST');
const cameraUsername = required('SEED_CAMERA_USERNAME');
const cameraPassword = required('SEED_CAMERA_PASSWORD');
const apiUrl = process.env.STUDIO_API_URL ?? 'http://localhost:5175';
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_ADMIN_DATABASE_URL;

/** Where the agent's MediaMTX listens, as the machine running it reaches it: this one, by default. */
const mediamtxHost = process.env.SEED_MEDIAMTX_HOST ?? 'localhost';

interface UserRow {
  id: string;
}

/** Make the account, or find it, and a session for it; its token is the bearer token Better Auth's plugin accepts. */
async function sessionToken() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query<UserRow>('select id from "user" where email = $1', [email]);
    const userId = existing.rows[0]?.id ?? randomUUID();
    if (existing.rows.length === 0) {
      await client.query(
        'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())',
        [userId, email.split('@')[0], email]
      );
    }
    const token = randomBytes(32).toString('base64url');
    await client.query(
      `insert into session (id, token, user_id, expires_at, created_at, updated_at, user_agent)
       values ($1, $2, $3, now() + interval '1 day', now(), now(), 'seed-local')`,
      [randomUUID(), token, userId]
    );
    return token;
  } finally {
    await client.end();
  }
}

const JsonSchema = z.json();
type Json = z.output<typeof JsonSchema>;

/** One call to the API as the seeded account, its answer parsed; throws with the API's error when it refuses. */
function caller(token: string) {
  return async <T extends z.ZodType>(schema: T, method: string, path: string, body?: Json): Promise<z.output<T>> => {
    const response = await fetch(new URL(path, apiUrl), {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return schema.parse(text === '' ? undefined : JSON.parse(text));
  };
}

/** The resolutions the camera streams, from VAPIX, so its driver sizes renditions to what it has. */
async function cameraResolutions() {
  const url = new URL('/axis-cgi/param.cgi?action=list&group=Properties.Image.Resolution', cameraHost);
  const authorization = `Basic ${Buffer.from(`${cameraUsername}:${cameraPassword}`).toString('base64')}`;
  const response = await fetch(url, { headers: { Authorization: authorization } });
  if (!response.ok) throw new Error(`The camera refused VAPIX: ${response.status}`);
  const line = (await response.text()).trim().split('=')[1];
  if (line === undefined) throw new Error('The camera listed no resolutions');
  return line.split(',');
}

/** Whatever the API made, by its ID. */
const IdentifiedSchema = z.object({ id: z.string() });
type Identified = z.output<typeof IdentifiedSchema>;
const KeyPairSchema = z.object({ privateKey: z.string() });
type KeyPair = z.output<typeof KeyPairSchema>;

const api = caller(await sessionToken());
const resolutions = await cameraResolutions();

const organisation: Identified = await api(IdentifiedSchema, 'POST', '/organisations', {
  name: 'Serval Reserve',
  displayName: 'Seeder'
});
const org = `/organisations/${organisation.id}`;
const network = await api(IdentifiedSchema, 'POST', `${org}/networks`, { name: 'Hide LAN' });
const agent = await api(IdentifiedSchema, 'POST', `${org}/agents`, { name: 'Hide agent', networkId: network.id });
await api(z.unknown(), 'PUT', `${org}/networks/${network.id}/active-agent`, { agentId: agent.id });
const keyPair: KeyPair = await api(KeyPairSchema, 'GET', `${org}/devices/${agent.id}/key-pair`);
const camera = await api(IdentifiedSchema, 'POST', `${org}/cameras`, {
  name: 'Serval cam',
  networkId: network.id,
  settings: { driver: 'axis', host: cameraHost, resolutions },
  credentials: { username: cameraUsername, password: cameraPassword }
});
const gateway = await api(IdentifiedSchema, 'POST', `${org}/gateways`, {
  name: 'Hide MediaMTX',
  kind: 'mediamtx',
  networkId: network.id,
  settings: {
    urls: {
      webrtc: `http://${mediamtxHost}:8889`,
      rtsp: `rtsp://${mediamtxHost}:8554`,
      hls: `http://${mediamtxHost}:8888`,
      rtmp: `rtmp://${mediamtxHost}:1935`
    }
  }
});
const stream = await api(IdentifiedSchema, 'POST', `${org}/streams`, { name: 'Serval', sourceDeviceId: camera.id });
const lan = await api(IdentifiedSchema, 'POST', `${org}/streams/${stream.id}/exposures`, {
  gatewayId: gateway.id,
  renditions: ['default', 'data_saver', 'balanced', 'quality']
});
const internet = await api(IdentifiedSchema, 'POST', `${org}/streams/${stream.id}/exposures`, {
  gatewayId: 'conservationtv',
  upstreamExposureId: lan.id,
  publisherDeviceId: agent.id,
  renditions: ['data_saver', 'quality']
});

const secretKey = Buffer.from(keyPair.privateKey, 'base64url').toString('hex');
console.log(
  JSON.stringify(
    {
      email,
      organisationId: organisation.id,
      networkId: network.id,
      agentId: agent.id,
      cameraId: camera.id,
      gatewayId: gateway.id,
      streamId: stream.id,
      exposures: { lan: lan.id, internet: internet.id },
      agentEnvironment: { AGENT_MODE: 'conservationtv', STUDIO_API_URL: apiUrl, AGENT_SECRET_KEY: secretKey }
    },
    null,
    2
  )
);
