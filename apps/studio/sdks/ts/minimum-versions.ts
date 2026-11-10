// The oldest version of each versioned operation that Client and the CLI keep, by operationId. Raise one to
// drop the versions only older servers serve.
export const minimumVersions: Record<string, number> = {};
