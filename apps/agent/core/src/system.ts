import { type Controllers, type Convergence } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Convergence<Controllers>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
