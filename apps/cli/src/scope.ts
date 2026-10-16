import { createStore } from '@conservationtv/store';
import { middleware } from 'incur';
import { z } from 'zod';

/** Options every command parses, wherever they appear on the command line. */
export const GlobalsSchema = z.object({
  endpoint: z.string().optional().describe('For `agent` commands: the iroh endpoint id of the agent to call')
});

export type Globals = z.output<typeof GlobalsSchema>;

/**
 * What a command's client factory needs but isn't passed: the generated commands call it without their context. The
 * resources are released, last first, once the command finishes.
 */
export interface Scope {
  globals: Globals;
  resources: AsyncDisposableStack;
}

const [withScope, useScope] = createStore<Scope>('command');
export { useScope };

/** Run each command in its own scope, and release what it opened when it finishes, however it finishes. */
export const scoped = middleware<undefined, undefined, typeof GlobalsSchema>(async (context, next) => {
  await using resources = new AsyncDisposableStack();
  await withScope({ globals: context.globals, resources }, next);
});
