import * as pulumi from '@pulumi/pulumi';
import type { ComposeWorkloadArgs, DeploymentSummary, WorkloadTarget } from '../contracts';
import { readHostname } from '../validate';
import { ComposeDeployment } from './deployment';

/** One compose app deployed to several machines, in parallel or one health-gated machine at a time. */
export class ComposeWorkload extends pulumi.ComponentResource {
  /** Ordered by priority, then machine id. */
  public readonly deployments: readonly ComposeDeployment[];
  public readonly summary: pulumi.Output<DeploymentSummary[]>;

  public constructor(name: string, args: ComposeWorkloadArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:ComposeWorkload', name, {}, opts);
    const deployments: ComposeDeployment[] = [];
    for (const target of orderTargets(name, args.targets)) {
      // A deployment depends on its predecessor as a component, which waits for every command in
      // it, health gates included.
      const previous = args.rollout === 'serial' ? deployments.at(-1) : undefined;
      deployments.push(
        new ComposeDeployment(
          `${name}-${target.machine.id}`,
          {
            target,
            app: typeof args.app === 'function' ? args.app(target) : args.app,
            ingress: args.ingress,
            dns: args.dns
          },
          pulumi.mergeOptions({ parent: this, dependsOn: opts?.dependsOn }, { dependsOn: previous })
        )
      );
    }
    this.deployments = deployments;
    this.summary = pulumi.all(deployments.map(deployment => deployment.summary));
    this.registerOutputs({ summary: this.summary });
  }
}

function orderTargets(name: string, targets: readonly WorkloadTarget[]): WorkloadTarget[] {
  if (!targets.length) throw new Error(`Workload "${name}" must declare at least one target.`);
  const machines = new Set<string>();
  const hostnames = new Set<string>();
  for (const { machine, hostname } of targets) {
    if (machines.has(machine.id)) throw new Error(`Workload "${name}" targets machine "${machine.id}" twice.`);
    machines.add(machine.id);
    const normalized = readHostname(hostname, `Workload "${name}" hostname`);
    if (hostnames.has(normalized)) throw new Error(`Workload "${name}" uses hostname "${normalized}" twice.`);
    hostnames.add(normalized);
  }
  return [...targets].sort(
    (left, right) => (left.priority ?? 0) - (right.priority ?? 0) || left.machine.id.localeCompare(right.machine.id)
  );
}
