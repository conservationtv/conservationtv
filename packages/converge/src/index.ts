// Converge: a desired-state runtime. A spec per top-level key, changed only by its mutator; each key's runtime
// converges to it and reports its own live status.
export {
  controller,
  type Apply,
  type KeyStatus,
  type Controller,
  type Controllers,
  type SystemSpec,
  type SystemStatus
} from './controller.ts';
export { converge, type Convergence, type ConvergeOptions } from './converge.ts';
export { NotMutating, type MutatorContext, type MutatorRun, type Recipe } from './mutator.ts';
