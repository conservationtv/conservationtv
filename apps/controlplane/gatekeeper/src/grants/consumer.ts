import { createStore } from '@conservationtv/store';
import type { ConsumerNamespace } from './identifiers.ts';

/** The consumer whose token authenticated the exchange. */
export interface Consumer {
  /** Where its MoQ roots live on the environment's relays, and what its grants are recorded under. */
  namespace: ConsumerNamespace;
}

const ConsumerStore = createStore<Consumer>('consumer');
export const [withConsumer, useConsumer] = ConsumerStore;
