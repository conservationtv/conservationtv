import type { Convergence } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentControllers } from './app.ts';

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Convergence<AgentControllers>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
