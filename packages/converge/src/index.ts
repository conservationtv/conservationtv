// Converge: a desired-state runtime. A spec per top-level key, changed only by its mutators; each key's runtime
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
export { converge, type Mutations, type Mutator, type Convergence, type ConvergeOptions } from './converge.ts';
