// Splat: a desired-state runtime. A spec per top-level key, changed only by its mutators; each key's runtime converges to it and
// reports its own live status.
export {
  resolver,
  type Apply,
  type KeyStatus,
  type Resolver,
  type Resolvers,
  type SystemSpec,
  type SystemStatus
} from './resolver.ts';
export { splat, staticMutator, type Mutations, type Mutator, type Splat, type SplatOptions } from './splat.ts';
