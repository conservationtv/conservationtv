import type { Client } from '@conservationtv/studio-sdk';
import { createStore } from '@conservationtv/store';

/** The studio API, signed as the agent's device. The agent supplies it on start; runtimes read it with `useStudio()`. */
export const [withStudio, useStudio] = createStore<Client>('studio');
