import { z } from 'zod';

// Where a pull request went once merged: each environment's first deploy that carried its merge commit, and how the
// services it deployed behaved in the hour either side of it, from Grafana Cloud's traces.

/** How a service did in an hour beside a deploy: requests, failures, exceptions by message, and slowness. */
export const WindowSchema = z.object({
  requests: z.number(),
  /** Requests answered 5xx. */
  serverErrors: z.number(),
  exceptions: z.array(z.object({ message: z.string(), count: z.number() })),
  /** Seconds; null without requests. */
  p95: z.number().nullable()
});
export type Window = z.output<typeof WindowSchema>;

export const ServiceHealthSchema = z.object({
  service: z.string(),
  before: WindowSchema,
  after: WindowSchema,
  /** The exception messages after the deploy that weren't before it. */
  newExceptions: z.array(z.string()),
  /** The service's failing traces around the deploy, in Grafana's Explore. */
  explore: z.url()
});
export type ServiceHealth = z.output<typeof ServiceHealthSchema>;

export const DeploySchema = z.object({
  environment: z.string(),
  /** The workflow that ran it, such as `studio` or `controlplane`. */
  workflow: z.string().nullable(),
  sha: z.string(),
  state: z.string(),
  createdAt: z.iso.datetime(),
  /** When it last changed state: finished, for one that succeeded. */
  updatedAt: z.iso.datetime(),
  url: z.url().nullable(),
  /** Null when Grafana isn't set up; empty when no service of the environment sends traces. */
  health: z.array(ServiceHealthSchema).nullable()
});
export type Deploy = z.output<typeof DeploySchema>;

export const DeploysSchema = z.object({
  /** The merge commit; null while the pull request is unmerged. */
  mergeSha: z.string().nullable(),
  deploys: z.array(DeploySchema)
});
export type Deploys = z.output<typeof DeploysSchema>;
