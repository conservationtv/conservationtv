import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { JSONValue } from 'hono/utils/types';
import type { ZodError } from 'zod';

import { findScenario, worldOf, type Scenario } from '../world/scenarios.ts';
import {
  matchOperation,
  OPERATION_MANIFEST,
  OPERATION_VERSION_HEADER,
  responseSchema,
  type Matched,
  type Operation
} from './contract.ts';
import { ApiError, PROJECTIONS, type Call, type ProjectedResponse, type Projection } from './projections.ts';

// The mock studio API: every scenario's world served under its own prefix, `/w/<scenario>/…`, so the web app is
// pointed at a world by its API URL alone (`API_URL=http://localhost:6431/w/typical`) and needs no change of its own.
// A prefix may carry a tag after `~` (`/w/typical~3/…`), which the capture uses to tell one page's requests from
// another's in the ledger.
//
// It answers what the web app reads: the handshake's manifest, the session, and each read operation's projection of
// the world, checked against the contract as it goes. Writes, and live connections to relays and agents, aren't
// simulated; they answer errors, and anything unanswered is noted in the ledger, for the report.

export interface LedgerEntry {
  /** What happened: an operation nothing projects, a response the contract refuses, a fault injected, a live connection refused. */
  kind: 'unmocked' | 'contract' | 'fault' | 'unsimulated';
  method: string;
  path: string;
  operationId?: string;
  detail: string;
}

/** What each prefix (scenario and tag) was asked that the mock couldn't answer as the API would. */
export const ledger = new Map<string, LedgerEntry[]>();

function note(prefix: string, entry: LedgerEntry) {
  const entries = ledger.get(prefix) ?? [];
  entries.push(entry);
  ledger.set(prefix, entries);
}

/** Set on a failure the scenario meant (an injected fault, a refused live connection), naming which. */
export const SCENARIO_HEADER = 'x-scenario-failure';

const MANIFEST_ETAG = `"${createHash('sha256').update(OPERATION_MANIFEST).digest('hex').slice(0, 16)}"`;

function errorBody(error: string, description: string) {
  return { error, error_description: description };
}

/** Lets the web app, on another origin, read responses with its cookie, as the API's CORS does. */
function allowOrigin(c: Context) {
  const origin = c.req.header('Origin');
  if (!origin) return;
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Expose-Headers', `ETag, ${SCENARIO_HEADER}`);
  c.header('Vary', 'Origin');
}

function sessionOf(scenario: Scenario) {
  const world = worldOf(scenario);
  const expiresAt = new Date(new Date(world.now).getTime() + 7 * 86_400_000).toISOString();
  return {
    session: {
      id: `session-${scenario.id}`,
      userId: world.viewer.id,
      token: `token-${scenario.id}`,
      expiresAt,
      createdAt: world.now,
      updatedAt: world.now,
      ipAddress: '127.0.0.1',
      userAgent: 'scenarios'
    },
    user: {
      id: world.viewer.id,
      name: world.viewer.name,
      email: world.viewer.email,
      emailVerified: true,
      image: null,
      createdAt: world.viewer.createdAt,
      updatedAt: world.viewer.createdAt
    }
  };
}

/** A status the mock answers a failure with. */
function failureStatus(status: number): ContentfulStatusCode {
  // SAFETY: every failure the mock answers is a 4xx or 5xx: an API error's status or a scenario's injected one, which
  // the specs only set to such statuses. Each of those carries a body.
  return status as ContentfulStatusCode;
}

/** One request to a scenario's world: which, where, and how. */
interface Asked {
  prefix: string;
  scenario: Scenario;
  method: string;
  path: string;
  url: URL;
}

/** CORS preflight, as the API answers it. */
function preflight(c: Context) {
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', c.req.header('Access-Control-Request-Headers') ?? '*');
  c.header('Access-Control-Max-Age', '600');
  return c.body(null, 204);
}

/** The SDK's handshake: the operation manifest, conditionally. */
function handshake(c: Context) {
  c.header('ETag', MANIFEST_ETAG);
  if (c.req.header('If-None-Match') === MANIFEST_ETAG) return c.body(null, 304);
  return c.body(OPERATION_MANIFEST, 200, { 'Content-Type': 'application/json' });
}

/** Better Auth: always signed in as the world's account, with no passkeys; anything else isn't simulated. */
function auth(c: Context, asked: Asked) {
  const { method, path } = asked;
  if (method === 'GET' && path === '/auth/get-session') return c.json(sessionOf(asked.scenario));
  if (method === 'GET' && path === '/auth/passkey/list-user-passkeys') return c.json([]);
  note(asked.prefix, { kind: 'unmocked', method, path, detail: 'Better Auth route not simulated' });
  return c.json(errorBody('not_simulated', 'Not simulated in scenarios'), 501);
}

/** The version a call asks for in its header; the latest served when it names none, and 0 for a versionless one. */
function versionOf(operation: Operation, header: string | undefined): number {
  if (operation.versions.length === 0) return 0;
  const requested = Number(header);
  return Number.isInteger(requested) && requested > 0 ? requested : Math.max(...operation.versions);
}

/** Apply the scenario's fault for the operation, if it has one: late, never, or an error status. */
async function injectFault(c: Context, asked: Asked, operationId: string) {
  const fault = asked.scenario.spec.faults[operationId];
  if (!fault) return undefined;
  note(asked.prefix, {
    kind: 'fault',
    method: asked.method,
    path: asked.path,
    operationId,
    detail: JSON.stringify(fault)
  });
  if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
  if (fault.hang) await new Promise(() => undefined);
  c.header(SCENARIO_HEADER, 'fault');
  if (!fault.status) return undefined;
  return c.json(
    errorBody('injected_fault', `Injected by the ${asked.scenario.id} scenario`),
    failureStatus(fault.status)
  );
}

/** The projection's response, or the API error it answers with instead. */
function project(projection: Projection, call: Call): ProjectedResponse | ApiError {
  try {
    return projection(call);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}

/** The request's JSON body, for a method that has one. */
async function bodyOf(c: Context, method: string): Promise<JSONValue | undefined> {
  if (method === 'GET' || method === 'DELETE') return undefined;
  return c.req.json().catch(() => undefined);
}

/** An API error, noting a refused live connection, which the scenario means, as such. */
function answerError(c: Context, asked: Asked, key: string, error: ApiError) {
  if (error.status === 503 && error.error === 'unavailable') {
    note(asked.prefix, {
      kind: 'unsimulated',
      method: asked.method,
      path: asked.path,
      operationId: key,
      detail: error.description
    });
    c.header(SCENARIO_HEADER, 'unsimulated');
  }
  return c.json(errorBody(error.error, error.description), failureStatus(error.status));
}

/** Why a response breaks the contract, in a line: its first few issues. */
function violations(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** An operation's response: its projection of the world, checked against the contract's schema for its version. */
async function answer(c: Context, asked: Asked, matched: Matched) {
  const { operation, params } = matched;
  const version = versionOf(operation, c.req.header(OPERATION_VERSION_HEADER));
  const key = `${operation.id}@${version}`;
  const faulted = await injectFault(c, asked, operation.id);
  if (faulted) return faulted;

  const projection = PROJECTIONS.get(key);
  if (!projection) {
    const detail = asked.method === 'GET' ? 'No projection for this read' : 'Writes are not simulated';
    note(asked.prefix, { kind: 'unmocked', method: asked.method, path: asked.path, operationId: key, detail });
    return c.json(errorBody('not_simulated', `${key} is not simulated in scenarios`), 501);
  }
  const world = worldOf(asked.scenario);
  const body = await bodyOf(c, asked.method);
  const response = project(projection, { world, params, query: asked.url.searchParams, body });
  if (response instanceof ApiError) return answerError(c, asked, key, response);

  const checked = (await responseSchema(operation.id, version))?.safeParse(response);
  if (checked && !checked.success) {
    const detail = violations(checked.error);
    note(asked.prefix, { kind: 'contract', method: asked.method, path: asked.path, operationId: key, detail });
    return c.json(
      errorBody('contract_violation', `The scenario's ${key} response breaks the contract: ${detail}`),
      500
    );
  }
  c.header('Cache-Control', 'no-store');
  return c.json(response, 200);
}

export function mockApi() {
  const app = new Hono();

  app.get('/', c =>
    c.json({
      about: 'The studio API, mocked over generated worlds. Point the web app at /w/<scenario>.',
      scenarios: '/scenarios'
    })
  );

  app.all('/w/:prefix/*', async c => {
    // A request to a scenario's world: preflight, the handshake, Better Auth, or one of the contract's operations.
    allowOrigin(c);
    const prefix = c.req.param('prefix');
    const scenarioId = prefix.split('~')[0] ?? '';
    const scenario = findScenario(scenarioId);
    if (!scenario) return c.json(errorBody('unknown_scenario', `No scenario ${scenarioId}`), 404);
    const url = new URL(c.req.url);
    const asked: Asked = {
      prefix,
      scenario,
      method: c.req.method,
      path: url.pathname.slice(`/w/${prefix}`.length) || '/',
      url
    };

    if (asked.method === 'OPTIONS') return preflight(c);
    if (asked.method === 'GET' && asked.path === '/operations.json') return handshake(c);
    if (asked.path.startsWith('/auth/')) return auth(c, asked);
    const matched = matchOperation(asked.method, asked.path);
    if (matched) return answer(c, asked, matched);
    note(prefix, {
      kind: 'unmocked',
      method: asked.method,
      path: asked.path,
      detail: 'No operation in the contract has this path'
    });
    return c.json(errorBody('not_found', 'No such route'), 404);
  });

  return app;
}
