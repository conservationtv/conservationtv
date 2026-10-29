import { Cli } from 'incur';
import { z } from 'zod';
import { studioClient } from '../api.js';
import { profileName, readCredentials, requireProfile, writeCredentials, type Credentials } from '../credentials.js';
import { LoginError } from '../errors.js';
import { choose, listOrganisations, registerDevice, summarise } from '../organisations.js';

// A profile is a signed-in session's browser device in one organisation, so it has an environment, an account and an
// organisation. `login` makes a session and its first profile; `profiles add` registers the current profile's session
// in another organisation; `profiles use` switches which profile commands act as, across every login.

function list() {
  const credentials = readCredentials();
  const names = Object.keys(credentials.profiles);
  const profiles = names.map(name => summarise(name, credentials));
  return { profiles };
}

/** Register the current profile's session in another organisation, and switch to it. */
async function add(requested: string | undefined) {
  const credentials = readCredentials();
  const active = requireProfile(credentials);
  const sessionId = active.profile.session;
  const studio = studioClient(active.apiUrl, active.session.token);
  await studio.handshake();
  const organisations = await listOrganisations(studio);
  const profiles = Object.values(credentials.profiles);
  const joined = profiles.filter(profile => profile.session === sessionId).map(profile => profile.organisationId);
  const remaining = organisations.filter(organisation => !joined.includes(organisation.id));
  if (remaining.length === 0) throw new LoginError('Every organisation you belong to already has a profile.');
  const choice = { requested, message: 'Add which organisation?', how: '--organisation' };
  const organisation = await choose(remaining, choice);
  const device = await registerDevice(studio, organisation);
  const name = profileName(credentials, active.session.env, organisation.name);
  const profile = { session: sessionId, organisationId: organisation.id, organisationName: organisation.name, device };
  const updated: Credentials = {
    ...credentials,
    profiles: { ...credentials.profiles, [name]: profile },
    current: name
  };
  writeCredentials(updated);
  return summarise(name, updated);
}

/** Switch the profile commands act as, by name. */
async function use(requested: string | undefined) {
  const credentials = readCredentials();
  const entries = Object.entries(credentials.profiles);
  if (entries.length === 0) throw new LoginError('There are no profiles: run `ctv login` first.');
  const choices = entries.map(([name, profile]) => {
    const session = credentials.sessions[profile.session]!;
    return { id: name, name: `${profile.organisationName} as ${session.email ?? 'unknown'} on ${session.env}` };
  });
  const choice = { requested, message: 'Switch to which profile?', how: 'a profile argument' };
  const chosen = await choose(choices, choice);
  const updated: Credentials = { ...credentials, current: chosen.id };
  writeCredentials(updated);
  return summarise(chosen.id, updated);
}

export const profilesCommand = Cli.create('profiles', {
  description: 'Your device in each organisation, on each login, and which one commands act as'
})
  .command('list', {
    description: 'List your profiles across every login, marking the current one',
    run: () => list()
  })
  .command('add', {
    description: "Register the current profile's login in another organisation, and switch to it",
    options: z.object({
      organisation: z.string().optional().describe('The organisation, by id or name; asked for when omitted')
    }),
    run: ({ options }) => add(options.organisation)
  })
  .command('use', {
    description: 'Switch to another profile',
    args: z.object({
      profile: z
        .string()
        .optional()
        .describe('The profile, by name such as `staging/simulo-sanctuary`; asked for when omitted')
    }),
    run: ({ args }) => use(args.profile)
  });
