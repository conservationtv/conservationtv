import * as pulumi from '@pulumi/pulumi';
import type { ComposeDeployment } from '../core/compose/deployment';
import type { ServiceEndpoint } from '../core/contracts';

/** What every relay directory lists about one relay, in rollout order. */
export interface RelayDirectoryEntry {
  /** Machine id. */
  id: string;
  /** Machine display name. */
  region: string;
  providerRegion: string;
  priority: number;
  publicHostname: string;
  publicAddress: string;
  endpoints: Record<string, ServiceEndpoint>;
}

/** One entry per deployment, extended with the protocol's own URLs. */
export function relayDirectory<T extends object>(
  deployments: readonly ComposeDeployment[],
  urls: (deployment: ComposeDeployment) => T
): pulumi.Output<Array<RelayDirectoryEntry & T>> {
  return pulumi.all(deployments.map(({ target }) => target.machine.address)).apply(addresses =>
    deployments.map((deployment, index): RelayDirectoryEntry & T => {
      const { machine, hostname, priority = 0 } = deployment.target;
      return {
        id: machine.id,
        region: machine.displayName,
        providerRegion: machine.region,
        priority,
        publicHostname: hostname,
        publicAddress: addresses[index]!,
        endpoints: { ...deployment.endpoints },
        ...urls(deployment)
      };
    })
  );
}
