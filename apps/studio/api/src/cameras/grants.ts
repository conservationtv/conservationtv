import {
  CAMERA_GRANT_ALGORITHM,
  CAMERA_GRANT_CLAIM,
  type CameraCommand,
  type CameraGrant,
  type CameraGrantPriority
} from '@conservationtv/cameras';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { importJWK, SignJWT } from 'jose';
import { agents, cameras, devices } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';

// Grants to control a camera (`@conservationtv/cameras`, grants.ts): what this API decides, and the agent that reaches
// the camera enforces. A camera is controlled through the active agent on its network, which is the only thing that
// reaches it; this API never calls a camera or an agent itself. A grant is signed with that agent's own identity,
// which this API holds, as a MediaMTX gateway's tokens are (src/gateways/mediamtx.ts), so the agent checks it against
// its own key. It names the device it was given to, whose connection to the agent proves it is that device.

/** How long a person's grant at the controls lasts: the studio asks for another while they stay. */
const CONTROL_LIFETIME_SECONDS = 300;
/** How long one resolved command may take to reach the camera's agent. */
const COMMAND_LIFETIME_SECONDS = 30;

/** The agent that serves a camera, with the identity its grants are signed by. */
export interface ServingAgent {
  id: string;
  publicId: string;
  publicKey: string;
  privateKey: Uint8Array;
}

/**
 * The agent that controls the camera: the active one on the camera's network, with its identity, read by trusted code
 * since its private key is hidden from request sessions. None for a camera that isn't `enabled`, is on no network, or
 * whose network has no active agent.
 */
export async function selectServingAgent(organisationId: string, cameraId: string) {
  const db = useDB({ trusted: true });
  const cameraDevices = alias(devices, 'camera_device');
  const [agent] = await db
    .select({
      id: devices.id,
      publicId: devices.publicId,
      publicKey: devices.publicKey,
      privateKey: devices.privateKey
    })
    .from(cameras)
    .innerJoin(cameraDevices, eq(cameraDevices.id, cameras.id))
    .innerJoin(
      agents,
      and(eq(agents.organisationId, cameras.organisationId), eq(agents.networkId, cameraDevices.networkId))
    )
    .innerJoin(devices, eq(devices.id, agents.id))
    .where(
      and(
        eq(cameras.organisationId, organisationId),
        eq(cameras.id, cameraId),
        eq(cameras.state, 'enabled'),
        eq(agents.active, true)
      )
    )
    .limit(1);
  return agent;
}

/**
 * The agent that controls each of the organisation's cameras, by camera, without the identities grants are signed by:
 * for deciding where a command would go before anything is signed (src/chat/decide.ts). A camera without one is left
 * out, as `selectServingAgent` finds none for it. Trusted code.
 */
export async function selectServingAgents(organisationId: string) {
  const db = useDB({ trusted: true });
  const cameraDevices = alias(devices, 'camera_device');
  const rows = await db
    .select({ cameraId: cameras.id, id: devices.id, publicId: devices.publicId })
    .from(cameras)
    .innerJoin(cameraDevices, eq(cameraDevices.id, cameras.id))
    .innerJoin(
      agents,
      and(eq(agents.organisationId, cameras.organisationId), eq(agents.networkId, cameraDevices.networkId))
    )
    .innerJoin(devices, eq(devices.id, agents.id))
    .where(and(eq(cameras.organisationId, organisationId), eq(cameras.state, 'enabled'), eq(agents.active, true)))
    .orderBy(cameras.id, devices.id);
  // The first of a network's active agents, should it ever have more than one.
  const serving = new Map<string, AgentReference>();
  for (const { cameraId, ...agent } of rows) if (!serving.has(cameraId)) serving.set(cameraId, agent);
  return serving;
}

/** An agent, by its device ID and the endpoint ID it is dialled at over iroh. */
export interface AgentReference {
  id: string;
  publicId: string;
}

/** The agent with the identity its grants are signed by, read by trusted code. None for a device that is gone. */
export async function selectAgentIdentity(agentId: string) {
  const db = useDB({ trusted: true });
  const [agent] = await db
    .select({
      id: devices.id,
      publicId: devices.publicId,
      publicKey: devices.publicKey,
      privateKey: devices.privateKey
    })
    .from(devices)
    .where(eq(devices.id, agentId));
  return agent;
}

/** A signed grant, and when it stops admitting anything. */
export interface SignedGrant {
  grant: string;
  expiresAt: string;
}

/** Sign the grant as the agent serving the camera, for the device whose endpoint ID is `holder`. */
async function sign(agent: ServingAgent, holder: string, grant: CameraGrant, lifetimeSeconds: number) {
  const environment = useEnvironment();
  const issuedAt = Math.floor(environment.clock() / 1000);
  const expiresAt = issuedAt + lifetimeSeconds;
  const d = Buffer.from(agent.privateKey).toString('base64url');
  const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: agent.publicKey, d }, CAMERA_GRANT_ALGORITHM);
  const token = await new SignJWT({ [CAMERA_GRANT_CLAIM]: grant })
    .setProtectedHeader({ alg: CAMERA_GRANT_ALGORITHM, kid: agent.publicId, typ: 'JWT' })
    .setIssuer(environment.variables.APP_URL)
    .setAudience(agent.publicId)
    .setSubject(holder)
    .setJti(crypto.randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  const signed: SignedGrant = { grant: token, expiresAt: new Date(expiresAt * 1000).toISOString() };
  return signed;
}

/** A grant for any command to the camera while it lasts, for someone at its controls. */
export function controlGrant(agent: ServingAgent, holder: string, cameraId: string) {
  const grant: CameraGrant = { cameraId, scope: { kind: 'control' }, priority: 'operator' };
  return sign(agent, holder, grant, CONTROL_LIFETIME_SECONDS);
}

/** A grant for exactly this command to the camera, once. */
export function commandGrant(
  agent: ServingAgent,
  holder: string,
  cameraId: string,
  command: CameraCommand,
  priority: CameraGrantPriority
) {
  const grant: CameraGrant = { cameraId, scope: { kind: 'command', command }, priority };
  return sign(agent, holder, grant, COMMAND_LIFETIME_SECONDS);
}
