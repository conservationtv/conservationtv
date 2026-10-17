import { createErrorHandler } from '@conservationtv/versioned-api/server';

export { handleNotFound } from '@conservationtv/versioned-api/server';

// No failures of the agent's own yet: the common handler renders routing, version and validation failures.
export const handleError = createErrorHandler();
