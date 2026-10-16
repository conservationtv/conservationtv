import { cancel, isCancel, select } from '@clack/prompts';
import { Client } from '@conservationtv/studio-sdk';
import { Cli } from 'incur';
import { z } from 'zod';
import { readCredential, writeCredential, type Credential, type Profile } from './credentials.js';
import { LoginError } from './errors.js';

// A profile is the signed-in session's browser device in one organisation. Logging in makes the first; `profiles add`
// registers the session in another; `profiles use` switches which one commands act as.

interface Organisation {
  id: string;
  name: string;
}

/** A studio client for the session, ready for versioned calls. */
async function sessionClient(apiUrl: string, token: string): Promise<Client> {
  const client = new Client({ baseUrl: apiUrl, headers: { authorization: `Bearer ${token}` } });
  await client.handshake();
  return client;
}

async function listOrganisations(client: Client): Promise<Organisation[]> {
  const result = await client.organisations.list.v1();
  if (result instanceof Error) throw result;
  return result.organisations.map(organisation => ({ id: organisation.id, name: organisation.name }));
}

/** Ask which one, on the terminal; a terminal-less run must say instead, the way `how` describes. */
async function pick(message: string, choices: Organisation[], how: string): Promise<Organisation> {
  const names = choices.map(choice => `${choice.name} (${choice.id})`);
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new LoginError(`Choose with ${how}: ${names.join(', ')}.`);
  // The prompt draws on stderr: stdout carries the command's result.
  const options = choices.map(choice => ({ value: choice.id, label: choice.name, hint: choice.id }));
  const id = await select({ message, options, output: process.stderr });
  if (isCancel(id)) {
    cancel('Cancelled.', { output: process.stderr });
    throw new LoginError('Cancelled.');
  }
  return choices.find(choice => choice.id === id)!;
}

/** The organisation `requested` names, by id or name; else the only choice; else the one the person picks. */
async function choose(choices: Organisation[], requested: string | undefined, message: string, how: string) {
  if (requested === undefined) return choices.length === 1 ? choices[0]! : pick(message, choices, how);
  const wanted = requested.toLowerCase();
  const match = choices.find(choice => choice.id === requested || choice.name.toLowerCase() === wanted);
  if (match !== undefined) return match;
  const names = choices.map(choice => `${choice.name} (${choice.id})`);
  throw new LoginError(`"${requested}" is not one of: ${names.join(', ')}.`);
}

/** Register the session's browser device in the organisation: get or create, with its private key. */
async function registerProfile(client: Client, organisation: Organisation): Promise<Profile> {
  const browser = await client.organisations.browser.ensure.v1({ id: organisation.id });
  if (browser instanceof Error) throw browser;
  const device = {
    id: browser.id,
    name: browser.name,
    publicKey: browser.publicKey,
    publicId: browser.publicId,
    privateKey: browser.privateKey
  };
  return { organisationId: organisation.id, organisationName: organisation.name, device };
}

/** A new session's first profile: in the organisation `requested` names, or the one the person picks. */
export async function firstProfile(apiUrl: string, token: string, requested: string | undefined): Promise<Profile> {
  const client = await sessionClient(apiUrl, token);
  const organisations = await listOrganisations(client);
  if (organisations.length === 0) throw new LoginError('This account is not a member of any organisation.');
  const organisation = await choose(organisations, requested, 'Which organisation?', '--organisation');
  return registerProfile(client, organisation);
}

/** A profile's device as commands report it: never its private key. */
export interface DeviceSummary {
  id: string;
  name: string;
  publicKey: string;
}

export interface ProfileSummary {
  organisationId: string;
  organisation: string;
  device: DeviceSummary;
  current: boolean;
}

export function summarise(profile: Profile, credential: Credential): ProfileSummary {
  const device = profile.device;
  return {
    organisationId: profile.organisationId,
    organisation: profile.organisationName,
    device: { id: device.id, name: device.name, publicKey: device.publicKey },
    current: profile.organisationId === credential.current
  };
}

function requireLogin(apiUrl: string): Credential {
  const credential = readCredential(apiUrl);
  if (credential === undefined) throw new LoginError('Not logged in: run `login` first.');
  return credential;
}

export function listProfiles(apiUrl: string) {
  const credential = requireLogin(apiUrl);
  const profiles = Object.values(credential.profiles);
  return { api: apiUrl, email: credential.email, profiles: profiles.map(profile => summarise(profile, credential)) };
}

/** Register the session in another organisation, and switch to it. */
export async function addProfile(apiUrl: string, requested: string | undefined): Promise<ProfileSummary> {
  const credential = requireLogin(apiUrl);
  const client = await sessionClient(apiUrl, credential.token);
  const organisations = await listOrganisations(client);
  const remaining = organisations.filter(organisation => !(organisation.id in credential.profiles));
  if (remaining.length === 0) throw new LoginError('Every organisation you belong to already has a profile.');
  const organisation = await choose(remaining, requested, 'Add which organisation?', '--organisation');
  const profile = await registerProfile(client, organisation);
  const updated: Credential = {
    ...credential,
    profiles: { ...credential.profiles, [profile.organisationId]: profile },
    current: profile.organisationId
  };
  writeCredential(apiUrl, updated);
  return summarise(profile, updated);
}

/** Switch the profile commands act as. */
export async function useProfile(apiUrl: string, requested: string | undefined): Promise<ProfileSummary> {
  const credential = requireLogin(apiUrl);
  const profiles = Object.values(credential.profiles);
  const choices = profiles.map(profile => ({ id: profile.organisationId, name: profile.organisationName }));
  const organisation = await choose(choices, requested, 'Switch to which organisation?', 'an organisation argument');
  const updated: Credential = { ...credential, current: organisation.id };
  writeCredential(apiUrl, updated);
  return summarise(updated.profiles[organisation.id]!, updated);
}

/** The `profiles` commands, for the login to `apiUrl`. */
export function profilesCommand(apiUrl: string) {
  return Cli.create('profiles', { description: 'Your device in each organisation, and which one commands act as' })
    .command('list', {
      description: 'List your profiles, marking the current one',
      run: ({ ok }) => ok(listProfiles(apiUrl))
    })
    .command('add', {
      description: 'Register this session in another organisation, and switch to it',
      options: z.object({
        organisation: z.string().optional().describe('The organisation, by id or name; asked for when omitted')
      }),
      run: ({ options, ok }) => addProfile(apiUrl, options.organisation).then(ok)
    })
    .command('use', {
      description: 'Switch to the profile for another organisation',
      args: z.object({
        organisation: z.string().optional().describe('The organisation, by id or name; asked for when omitted')
      }),
      run: ({ args, ok }) => useProfile(apiUrl, args.organisation).then(ok)
    });
}
