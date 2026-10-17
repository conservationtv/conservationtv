import { buildCli as buildStudioCli } from '@conservationtv/studio-cli';
import { Cli } from 'incur';
import { studioClient } from './api.js';
import { agentCommand } from './commands/agent.js';
import { loginCommand, logoutCommand } from './commands/auth.js';
import { profilesCommand } from './commands/profiles.js';
import { currentToken } from './credentials.js';
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

// The studio API's generated commands, at the top level, with the stored session's token.
buildStudioCli(cli, () => {
  const token = currentToken();
  return studioClient(token);
});

await cli.serve();
