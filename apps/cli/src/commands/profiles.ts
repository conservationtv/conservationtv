import { Cli } from 'incur';
import { z } from 'zod';
import { apiUrl, studioClient } from '../api.js';
import { requireCredential, saveCredential, type Credential } from '../credentials.js';
import { LoginError } from '../errors.js';
import { choose, listOrganisations, registerProfile, summarise } from '../organisations.js';

// A profile is the signed-in session's browser device in one organisation. `login` makes the first; `profiles add`
// registers the session in another; `profiles use` switches which one commands act as.

function list() {
  const credential = requireCredential();
  const profiles = Object.values(credential.profiles);
  const summaries = profiles.map(profile => summarise(profile, credential));
  return { api: apiUrl, email: credential.email, profiles: summaries };
}

/** Register the session in another organisation, and switch to it. */
async function add(requested: OrganisationArgument) {
  const credential = requireCredential();
  const studio = studioClient(credential.token);
  await studio.handshake();
  const organisations = await listOrganisations(studio);
  const remaining = organisations.filter(organisation => !(organisation.id in credential.profiles));
  if (remaining.length === 0) throw new LoginError('Every organisation you belong to already has a profile.');
  const choice = { requested, message: 'Add which organisation?', how: '--organisation' };
  const organisation = await choose(remaining, choice);
  const profile = await registerProfile(studio, organisation);
  const updated: Credential = {
    ...credential,
    profiles: { ...credential.profiles, [profile.organisationId]: profile },
    current: profile.organisationId
  };
  saveCredential(updated);
  return summarise(profile, updated);
}

/** Switch the profile commands act as. */
async function use(requested: OrganisationArgument) {
  const credential = requireCredential();
  const profiles = Object.values(credential.profiles);
  const organisations = profiles.map(profile => ({ id: profile.organisationId, name: profile.organisationName }));
  const choice = { requested, message: 'Switch to which organisation?', how: 'an organisation argument' };
  const organisation = await choose(organisations, choice);
  const updated: Credential = { ...credential, current: organisation.id };
  saveCredential(updated);
  return summarise(updated.profiles[organisation.id]!, updated);
}

const OrganisationArgumentSchema = z
  .string()
  .optional()
  .describe('The organisation, by id or name; asked for when omitted');
type OrganisationArgument = z.output<typeof OrganisationArgumentSchema>;

export const profilesCommand = Cli.create('profiles', {
  description: 'Your device in each organisation, and which one commands act as'
})
  .command('list', {
    description: 'List your profiles, marking the current one',
    run: () => list()
  })
  .command('add', {
    description: 'Register this session in another organisation, and switch to it',
    options: z.object({ organisation: OrganisationArgumentSchema }),
    run: ({ options }) => add(options.organisation)
  })
  .command('use', {
    description: 'Switch to the profile for another organisation',
    args: z.object({ organisation: OrganisationArgumentSchema }),
    run: ({ args }) => use(args.organisation)
  });
