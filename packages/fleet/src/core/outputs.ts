import * as pulumi from '@pulumi/pulumi';
import type { Fleet } from './fleet';
import type { ComposeWorkload, WorkloadNodeSummary } from './workload';

export interface FleetSummaryArgs {
  workloads: ComposeWorkload[];
}

interface SshConfigOutputArgs {
  fleet: Fleet;
  workloads: ComposeWorkload[];
}

export function fleetSummary(args: FleetSummaryArgs): pulumi.Output<Record<string, WorkloadNodeSummary[]>> {
  const names = new Set<string>();
  for (const workload of args.workloads) {
    if (names.has(workload.workloadName))
      throw new Error(`Duplicate workload name "${workload.workloadName}" in fleet summary.`);
    names.add(workload.workloadName);
  }
  return pulumi
    .all(args.workloads.map(workload => workload.summary))
    .apply(summaries =>
      Object.fromEntries(summaries.map((summary, index) => [args.workloads[index].workloadName, summary]))
    );
}

export function sshConfigOutput(args: SshConfigOutputArgs): pulumi.Output<string> {
  void args.fleet;
  return pulumi.all(args.workloads.map(workload => workload.sshConfig)).apply(configs => configs.join('\n'));
}
