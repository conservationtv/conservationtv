import { buildCli as buildStudioCli } from '@conservationtv/studio-cli';
import { Cli } from 'incur';
import { apiUrlOf, studioClient } from './api.js';
import { agentCommand } from './commands/agent.js';
import { loginCommand, logoutCommand } from './commands/auth.js';
import { profilesCommand } from './commands/profiles.js';
import { activeProfile, readCredentials } from './credentials.js';
import { mapErrors } from './errors.js';
import { GlobalsSchema, scoped } from './scope.js';

const cli = Cli.create('ctv', {
  description: 'The conservation.tv CLI: the studio API, and agents over iroh',
  format: 'json',
  globals: GlobalsSchema
})
  .use(mapErrors)
  .use(scoped)
  .command(loginCommand)
  .command(logoutCommand)
  .command(profilesCommand)
  .command(agentCommand);

// The studio API's generated commands, at the top level: on the active profile's environment, with its session's
// token. `STUDIO_TOKEN` replaces the token, for scripts and CI; without a profile, they call prod's.
buildStudioCli(cli, () => {
  // Each fallback stands alone: the profile picks the API and the token, and `STUDIO_TOKEN` can replace the token.
  const credentials = readCredentials();
  const active = activeProfile(credentials);
  const apiUrl = active?.apiUrl ?? apiUrlOf('prod');
  const token = process.env.STUDIO_TOKEN || active?.session.token;
  return studioClient(apiUrl, token);
});

await cli.serve();
