import * as pulumi from '@pulumi/pulumi';
import type { Fleet } from '../fleet';
import type { Node } from '../node';
import type { ComposeRecord, DeployStep, SystemdUnitSpec } from '../host/composeHost';
import type { RemoteFileSpec } from '../host/remote';
import type { ServiceEndpointDefinition, ServiceRegistry } from '../endpoints';

/** Context supplied when an addon is requested by a workload on a node. */
export interface AddonAttachmentContext {
  fleet: Fleet;
  node: Node;
  workloadName: string;
  hostname: string;
}

/** What an addon contributes to a Compose surface and deploy pipeline. */
export interface HostAddonContribution {
  name: string;
  services: ServiceRegistry & ComposeRecord;
  volumes?: ComposeRecord;
  files?: RemoteFileSpec[];
  systemdUnits?: SystemdUnitSpec[];
  deploySteps?: DeployStep[];
  endpoints?: Record<string, ServiceEndpointDefinition>;
  summary?: Record<string, pulumi.Input<unknown>>;
}

export type AddonScope = 'workload' | 'node';

/**
 * Base class for addon components. An addon is instantiated once with `new` and
 * attached to any number of nodes; per-node cloud resources are created as children
 * of the addon component when `attachTo` runs. Node-scoped addons are deployed in a
 * stable node-owned Compose project, while workload-scoped addons join each workload.
 */
export abstract class Addon extends pulumi.ComponentResource {
  public readonly scope: AddonScope;

  protected constructor(
    type: string,
    name: string,
    opts?: pulumi.ComponentResourceOptions,
    scope: AddonScope = 'workload'
  ) {
    super(type, name, {}, opts);
    this.scope = scope;
  }

  public abstract attachTo(context: AddonAttachmentContext): HostAddonContribution;
}
