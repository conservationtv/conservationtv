import { arkenv } from '@arkenv/standard';
import { config, services, type Variables } from './config.ts';

type Clients = ReturnType<typeof services>;

/** The runner's variables and the clients built from them. */
export interface Environment extends Clients {
  variables: Variables;
}

/** An invalid environment fails at startup rather than serving. */
export const createEnvironment = (): Environment => {
  const variables = arkenv(config);

  return {
    variables,
    ...services(variables)
  };
};
