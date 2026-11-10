import {
  Client as AgentClient,
  HttpError,
  OperationVersionChangedError,
  OperationVersionUnavailableError
} from '@conservationtv/agent-sdk';
import { Client as StudioClient, DeviceIdentity, deviceSignature } from '@conservationtv/studio-sdk';
import type { BrowserRelay, IrohHttpClient } from '@strangecyan/iroh-http-browser';

import { api } from './api';
import { API_URL } from './auth-client';
import { bytesFromBase64url } from './encoding';
import { relayTicket } from './iroh-ticket';

// Calling an agent directly from the browser, as HTTP over iroh, the way the CLI does (apps/cli/src/iroh.ts): the
// browser acts as its own device in the organisation (`organisations.browser.ensure`), asks the studio API, signed as
// that device, for the relay every device uses, binds an endpoint on it, and dials the agent at its public ID there.
// The agent sees the browser device's public ID as the request's peer; nothing passes through the studio API.
//
// A browser can't holepunch, so every exchange is relayed. iroh admits one endpoint per ID to a relay at a time, and
// every tab of a session is the same device, so the endpoint lives in a SharedWorker the tabs share
// (`createSharedEndpoint`) wherever the browser has one, and in the tab only where it doesn't.
//
// The device's private key is read here and handed straight to the endpoint: it is never put in the query cache. This
// module is plain I/O with a little connection keeping; the app reads agents through TanStack Query
// (src/queries/agent-system.ts), which decides when to ask and what to do with a failure.

/** How long before its lease expires an endpoint's lease is renewed: the relay refuses new connections after it. */
const LEASE_MARGIN_MS = 60_000;
/** How long an agent gets to answer a dial: one that is off never refuses, it just isn't there. */
const DIAL_TIMEOUT_MS = 15_000;
/**
 * The suffix iroh-http gives a peer's origin, so requests built from it go to that peer. The library exports it as
 * `ORIGIN_SUFFIX` from its entry, which isn't imported here: that would bring its WebAssembly glue into the tab,
 * where the SharedWorker is meant to hold it.
 */
const PEER_ORIGIN_SUFFIX = '.iroh';

/** An agent that was dialled and didn't answer in time: off, or offline. The endpoint itself is fine. */
class AgentUnanswered extends Error {
  constructor() {
    super('The agent didn’t answer. It may be off or offline.');
  }
}

/** What dials agents: an endpoint in a SharedWorker, or one in this tab. */
interface Dialler {
  connect: (ticket: string) => Promise<IrohHttpClient>;
  /** Let go of the endpoint: this tab's hold on the shared one, or the tab's own. */
  close: () => Promise<void>;
}

/** An organisation's bound endpoint, the relay agents are found on, and when its lease there runs out. */
interface OrganisationSession {
  studio: StudioClient;
  dialler: Dialler;
  relayUrl: string;
  leaseExpiresAt: number;
}

/** An open connection to one agent: its API, and the transport beneath it, to close. */
interface AgentLink {
  agent: AgentClient;
  transport: IrohHttpClient;
}

/** The endpoint shared by every tab of this session, for browsers that can share one; otherwise one of this tab's. */
async function bind(secretKey: Uint8Array, relay: BrowserRelay): Promise<Dialler> {
  const shared = await import('@strangecyan/iroh-http-browser/shared');
  if (shared.isSharedEndpointSupported()) {
    const endpoint = await shared.createSharedEndpoint({ secretKey, relay });
    return { connect: ticket => shared.connect(endpoint, ticket), close: () => endpoint.close() };
  }
  // A second tab binding the same device takes the relay from the first: the cost of a browser without SharedWorker.
  const iroh = await import('@strangecyan/iroh-http-browser');
  const endpoint = await iroh.createEndpoint({ secretKey, relay });
  return {
    connect: async ticket => {
      const address = await iroh.getAddressFromString(ticket);
      return iroh.connect(endpoint, address);
    },
    close: () => endpoint.close()
  };
}

/**
 * Start an iroh session in the organisation: get this auth session's browser device there, lease its endpoint on the
 * studio's relay, signed as the device, and bind it.
 */
async function openSession(organisationId: string): Promise<OrganisationSession> {
  const browser = await api.organisations.browser.ensure.v1({ id: organisationId });
  if (browser instanceof Error) throw browser;
  const secretKey = bytesFromBase64url(browser.privateKey);
  const identity = await DeviceIdentity.fromSecretKey(secretKey);
  const studio = new StudioClient({ baseUrl: API_URL, auth: deviceSignature(identity) });
  await studio.handshake();
  const session = await studio.irohSessions.create.v1();
  if (session instanceof Error) throw session;
  const relay = { relays: [{ url: session.relay.url, authToken: session.relay.authToken }] };
  const dialler = await bind(secretKey, relay);
  return { studio, dialler, relayUrl: session.relay.url, leaseExpiresAt: Date.parse(session.lease.expiresAt) };
}

/** Ask for the lease again shortly before it runs out; the endpoint stays bound, and keeps its connections. */
async function renewLease(session: OrganisationSession): Promise<void> {
  if (session.leaseExpiresAt - Date.now() > LEASE_MARGIN_MS) return;
  const renewed = await session.studio.irohSessions.create.v1();
  if (renewed instanceof Error) throw renewed;
  session.leaseExpiresAt = Date.parse(renewed.lease.expiresAt);
}

/** Each organisation's session, by its ID: started by the first call into it, and kept until it fails or is closed. */
const sessions = new Map<string, Promise<OrganisationSession>>();
/** Each agent's open connection, by organisation and the agent's public ID. */
const links = new Map<string, Promise<AgentLink>>();

function linkKey(organisationId: string, agentPublicId: string): string {
  return `${organisationId}:${agentPublicId}`;
}

function sessionOf(organisationId: string): Promise<OrganisationSession> {
  const existing = sessions.get(organisationId);
  if (existing) return existing;
  const opening = openSession(organisationId);
  sessions.set(organisationId, opening);
  // A session that failed to start isn't kept: the next call starts another.
  opening.catch(() => sessions.delete(organisationId));
  return opening;
}

/** Let go of the organisation's endpoint, if this is still its session, so the next call binds afresh. */
function dropSession(organisationId: string, session: Promise<OrganisationSession>): void {
  if (sessions.get(organisationId) !== session) return;
  sessions.delete(organisationId);
  void session.then(opened => opened.dialler.close()).catch(() => undefined);
}

/** Close the agent's connection, if this is still it, so the next call dials again. */
function dropLink(key: string, link: Promise<AgentLink>): void {
  if (links.get(key) !== link) return;
  links.delete(key);
  void link.then(open => open.transport.close()).catch(() => undefined);
}

/** Connect to the agent on the session's relay, and negotiate its SDK's operation versions over the connection. */
async function connect(session: OrganisationSession, agentPublicId: string): Promise<AgentLink> {
  await renewLease(session);
  const ticket = relayTicket(agentPublicId, session.relayUrl);
  const transport = await session.dialler.connect(ticket);
  const agent = new AgentClient({
    baseUrl: `http://${transport.peer.endpointId}${PEER_ORIGIN_SUFFIX}`,
    fetch: (input, init) => transport.fetch(input, init)
  });
  try {
    await agent.handshake();
  } catch (error) {
    transport.close();
    throw error;
  }
  return { agent, transport };
}

/** The connection, or `AgentUnanswered` if it takes too long; one that arrives after that is closed, not kept. */
async function withinDialTimeout(connecting: Promise<AgentLink>): Promise<AgentLink> {
  const settled = new AbortController();
  const expired = new Promise<never>((_resolve, reject) => {
    const handle = setTimeout(() => {
      void connecting.then(late => late.transport.close()).catch(() => undefined);
      reject(new AgentUnanswered());
    }, DIAL_TIMEOUT_MS);
    settled.signal.addEventListener('abort', () => clearTimeout(handle));
  });
  try {
    return await Promise.race([connecting, expired]);
  } finally {
    settled.abort();
  }
}

/**
 * Dial the agent in the organisation's session. An agent that doesn't answer leaves the session as it is; any other
 * failure to dial (the endpoint has closed, the relay is gone) lets the session go, so the next call binds afresh.
 */
async function dial(organisationId: string, agentPublicId: string): Promise<AgentLink> {
  const session = sessionOf(organisationId);
  const opened = await session;
  try {
    return await withinDialTimeout(connect(opened, agentPublicId));
  } catch (error) {
    if (!(error instanceof AgentUnanswered)) dropSession(organisationId, session);
    throw error;
  }
}

function linkOf(organisationId: string, agentPublicId: string): Promise<AgentLink> {
  const key = linkKey(organisationId, agentPublicId);
  const existing = links.get(key);
  if (existing) return existing;
  const dialling = dial(organisationId, agentPublicId);
  links.set(key, dialling);
  // A dial that failed isn't kept: the next call dials again.
  dialling.catch(() => links.delete(key));
  return dialling;
}

/**
 * Whether a call's error is the agent's own answer: it refused (an HTTP error), or doesn't serve that operation version.
 * Versioned calls return every failure rather than reject, so anything else (the transport's fetch failing, a handshake
 * that couldn't fetch the agent's document) is the connection beneath breaking.
 */
function answeredBy(error: Error): boolean {
  return (
    error instanceof HttpError ||
    error instanceof OperationVersionUnavailableError ||
    error instanceof OperationVersionChangedError
  );
}

/**
 * Ask the agent something over its API, on a connection kept open between calls. An answer that is one of the SDK's
 * errors (the agent refused, or doesn't serve that operation version) is thrown with the connection kept; a call that
 * fails beneath that (the connection broke) closes it, so the next call dials again.
 */
export async function askAgent<Answer>(
  organisationId: string,
  agentPublicId: string,
  ask: (agent: AgentClient) => Promise<Answer | Error>
): Promise<Answer> {
  const key = linkKey(organisationId, agentPublicId);
  const link = linkOf(organisationId, agentPublicId);
  const { agent } = await link;
  const asking = ask(agent);
  // An `ask` that throws rather than returns its error is treated as a broken connection too.
  asking.catch(() => dropLink(key, link));
  const answer = await asking;
  if (!(answer instanceof Error)) return answer;
  if (!answeredBy(answer)) dropLink(key, link);
  throw answer;
}

/**
 * Close every connection and let go of every endpoint: when the signed-in account changes, so nothing dials as the
 * last account's device. The next call starts again as whoever is signed in.
 */
export function closeAgentSessions(): void {
  for (const [key, link] of links) dropLink(key, link);
  for (const [organisationId, session] of sessions) dropSession(organisationId, session);
}
