import { Cli } from 'incur';
import { z } from 'zod';
import { apiUrlOf, ENVIRONMENTS, studioClient, type Environment } from '../api.js';
import {
  activeProfile,
  credentialsPath,
  findSession,
  profileName,
  readCredentials,
  withoutSession,
  writeCredentials,
  type Credentials
} from '../credentials.js';
import { authorize, signOut } from '../device-flow.js';
import { LoginError } from '../errors.js';
import { choose, listOrganisations, registerDevice, summarise } from '../organisations.js';

/** A new session's first organisation, the one `requested` names or one the person picks, and its device there. */
async function firstDevice(apiUrl: string, token: string, requested: string | undefined) {
  const studio = studioClient(apiUrl, token);
  await studio.handshake();
  const organisations = await listOrganisations(studio);
  if (organisations.length === 0) throw new LoginError('This account is not a member of any organisation.');
  const choice = { requested, message: 'Which organisation?', how: '--organisation' };
  const organisation = await choose(organisations, choice);
  const device = await registerDevice(studio, organisation);
  return { organisation, device };
}

/**
 * The device flow against `env`, then the session's browser device in an organisation: a new profile, which becomes
 * current. Other logins stay; one to the same account and environment is replaced, and signed out with its devices.
 */
async function login(env: Environment, requested: string | undefined) {
  const apiUrl = apiUrlOf(env);
  const session = await authorize(apiUrl);
  // A session that can't get a profile is signed out again rather than left open.
  await using unfinished = new AsyncDisposableStack();
  unfinished.defer(() => signOut(apiUrl, session.token));
  const { organisation, device } = await firstDevice(apiUrl, session.token, requested);
  unfinished.move();

  const stored = readCredentials();
  const replaced = findSession(stored, env, session.email);
  const previous = replaced === undefined ? undefined : stored.sessions[replaced];
  const remaining = replaced === undefined ? stored : withoutSession(stored, replaced);
  const sessionId = crypto.randomUUID();
  const name = profileName(remaining, env, organisation.name);
  const profile = { session: sessionId, organisationId: organisation.id, organisationName: organisation.name, device };
  const credentials: Credentials = {
    sessions: { ...remaining.sessions, [sessionId]: { env, ...session } },
    profiles: { ...remaining.profiles, [name]: profile },
    current: name
  };
  writeCredentials(credentials);
  if (previous !== undefined) await signOut(apiUrl, previous.token).catch(() => undefined);
  return summarise(name, credentials);
}

/**
 * Revoke the session of the profile commands act as, which removes its browser devices, then forget it and all its
 * profiles locally either way. Other logins stay, and none of them becomes current.
 */
async function logout() {
  const credentials = readCredentials();
  const active = activeProfile(credentials);
  if (active === undefined) return { signedOut: false };
  const sessionId = active.profile.session;
  const profiles = Object.entries(credentials.profiles);
  const removed = profiles.filter(([, profile]) => profile.session === sessionId).map(([name]) => name);
  try {
    await signOut(active.apiUrl, active.session.token);
  } finally {
    const remaining = withoutSession(credentials, sessionId);
    writeCredentials(remaining);
  }
  return { signedOut: true, env: active.session.env, email: active.session.email, removed };
}

export const loginCommand = Cli.create('login', {
  description: `Sign in to an environment: approve a code in the browser, pick an organisation, and keep both in ${credentialsPath()}`,
  options: z.object({
    env: z
      .enum(ENVIRONMENTS)
      .default('prod')
      .describe('The studio API to sign in to: `local` is `pnpm dev`, the others are its deployed stacks'),
    organisation: z.string().optional().describe('The organisation to start in, by id or name; asked for when omitted')
  }),
  run: ({ options }) => login(options.env, options.organisation)
});

export const logoutCommand = Cli.create('logout', {
  description: "Sign out the current profile's login, removing its devices and every profile it has",
  run: () => logout()
});
