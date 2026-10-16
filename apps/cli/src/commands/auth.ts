import { Cli } from 'incur';
import { z } from 'zod';
import { apiUrl, studioClient } from '../api.js';
import { credentialsPath, forgetCredential, readCredential, saveCredential, type Credential } from '../credentials.js';
import { authorize, signOut } from '../device-flow.js';
import { LoginError } from '../errors.js';
import { choose, listOrganisations, registerProfile, summarise } from '../organisations.js';

/** A new session's first profile: in the organisation `requested` names, or one the person picks. */
async function firstProfile(token: string, requested: string | undefined) {
  const studio = studioClient(token);
  await studio.handshake();
  const organisations = await listOrganisations(studio);
  if (organisations.length === 0) throw new LoginError('This account is not a member of any organisation.');
  const choice = { requested, message: 'Which organisation?', how: '--organisation' };
  const organisation = await choose(organisations, choice);
  return registerProfile(studio, organisation);
}

/**
 * The device flow, then the session's browser device in an organisation: its first and current profile. A login it
 * replaces is signed out, removing that session's devices.
 */
async function login(requested: string | undefined) {
  const session = await authorize();
  // A session that can't get a profile is signed out again rather than left open.
  await using unfinished = new AsyncDisposableStack();
  unfinished.defer(() => signOut(session.token));
  const profile = await firstProfile(session.token, requested);
  unfinished.move();

  const previous = readCredential();
  const credential: Credential = {
    ...session,
    profiles: { [profile.organisationId]: profile },
    current: profile.organisationId
  };
  saveCredential(credential);
  if (previous !== undefined) await signOut(previous.token).catch(() => undefined);
  return { api: apiUrl, email: credential.email, profile: summarise(profile, credential) };
}

/** Revoke the stored session on the API, which removes its browser devices, then forget it locally either way. */
async function logout() {
  const credential = readCredential();
  if (credential === undefined) return { api: apiUrl, signedOut: false };
  try {
    await signOut(credential.token);
  } finally {
    forgetCredential();
  }
  return { api: apiUrl, signedOut: true };
}

export const loginCommand = Cli.create('login', {
  description: `Sign in: approve a code in the browser, pick an organisation, and keep both in ${credentialsPath()}`,
  options: z.object({
    organisation: z.string().optional().describe('The organisation to start in, by id or name; asked for when omitted')
  }),
  run: ({ options }) => login(options.organisation)
});

export const logoutCommand = Cli.create('logout', {
  description: "Sign out of the API, which removes every profile's device, and forget the stored login",
  run: () => logout()
});
