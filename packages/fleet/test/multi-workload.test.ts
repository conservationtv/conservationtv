import * as pulumi from '@pulumi/pulumi';
import { describe, expect, it } from 'vitest';
import { Addon, type AddonAttachmentContext, type HostAddonContribution } from '../src/core/addons/types';
import type { ServiceEndpoint } from '../src/core/endpoints';
import { Fleet, type HostnameSubject } from '../src/core/fleet';
import type { Machine, MachineArgs, MachineIngressArgs } from '../src/core/machine';
import { MachineProvider } from '../src/core/machine';
import { Node } from '../src/core/node';
import { ComposeWorkload } from '../src/core/workload';

pulumi.runtime.setMocks({
  newResource: args => ({ id: `${args.name}-id`, state: args.inputs }),
  call: args => args.inputs
});

describe('multiple workloads per node', () => {
  it('reuses one machine, adds ingress per workload, and serializes host deployment', () => {
    const fleet = testFleet('shared-fleet');
    const provider = new TestMachineProvider('provider');
    const node = new Node('shared-node', {
      fleet,
      provider,
      providerRegion: 'test-1',
      hostname: 'shared.example.test'
    });

    const first = node.attach({
      workloadName: 'one',
      hostname: 'one.example.test',
      ingress: [],
      endpoints: {},
      paths: ['/opt/one/docker-compose.yml'],
      containerNames: []
    });
    const firstDeployment = new pulumi.ComponentResource('test:index:Deployment', 'first-deployment');
    node.completeAttachment('one', firstDeployment);
    const second = node.attach({
      workloadName: 'two',
      hostname: 'two.example.test',
      ingress: [],
      endpoints: {},
      paths: ['/opt/two/docker-compose.yml'],
      containerNames: []
    });

    expect(provider.machineCreations).toBe(1);
    expect(provider.ingressRegistrations).toBe(2);
    expect(second.machine).toBe(first.machine);
    expect(second.deployAfter).toContain(firstDeployment);
    expect(node.attachedWorkloads).toEqual(['one', 'two']);
    expect(node.hostname).toBe('shared.example.test');
  });

  it('deploys a node-scoped addon only once per shared node', () => {
    const fleet = testFleet('addon-fleet');
    const node = new Node('addon-node', {
      fleet,
      provider: new TestMachineProvider('addon-provider'),
      providerRegion: 'test-1'
    });
    const addon = new TestNodeAddon('shared-addon');
    const first = node.attachAddon(addon, { fleet, node, workloadName: 'one', hostname: 'one.example.test' });
    const second = node.attachAddon(addon, { fleet, node, workloadName: 'two', hostname: 'two.example.test' });

    expect(addon.attachments).toBe(1);
    expect(first.deploy).toBe(true);
    expect(second.deploy).toBe(false);
    expect(second.contribution).toBe(first.contribution);
  });

  it('rejects listeners, paths, and explicit container names claimed by another workload', () => {
    const listenerNode = testNode('listener-node');
    listenerNode.attach(
      attachment('one', {
        endpoints: { https: endpoint('one.https', 443) }
      })
    );
    expect(() =>
      listenerNode.attach(
        attachment('two', {
          endpoints: { https: endpoint('two.https', 443) }
        })
      )
    ).toThrow(/Host listener collision.*one.*two/);

    const pathNode = testNode('path-node');
    pathNode.attach(attachment('one', { paths: ['/etc/systemd/system/shared.service'] }));
    expect(() => pathNode.attach(attachment('two', { paths: ['/etc/systemd/system/shared.service'] }))).toThrow(
      /Remote file path collision/
    );

    const containerNode = testNode('container-node');
    containerNode.attach(attachment('one', { containerNames: ['shared-container'] }));
    expect(() => containerNode.attach(attachment('two', { containerNames: ['shared-container'] }))).toThrow(
      /Container name collision/
    );
  });

  it('keeps node-scoped addon Compose ownership outside either workload', () => {
    const fleet = testFleet();
    const node = new Node('compose-shared-node', {
      fleet,
      provider: new TestMachineProvider('compose-shared-provider'),
      providerRegion: 'test-1'
    });
    const addon = new TestNodeAddon('compose-shared-addon');
    const one = new ComposeWorkload('compose-one', {
      fleet,
      nodes: [node],
      domain: 'one.example.test',
      addons: [addon],
      app: () => app('one', 8081)
    });
    const two = new ComposeWorkload('compose-two', {
      fleet,
      nodes: [node],
      domain: 'two.example.test',
      addons: [addon],
      app: () => app('two', 8082)
    });

    expect(one.nodes.get('compose-shared-node')?.nodeAddonHosts).toHaveLength(1);
    expect(two.nodes.get('compose-shared-node')?.nodeAddonHosts).toHaveLength(0);
    expect(addon.attachments).toBe(1);
  });
});

function testNode(name: string): Node {
  const fleet = testFleet(`${name}-fleet`);
  return new Node(name, {
    fleet,
    provider: new TestMachineProvider(`${name}-provider`),
    providerRegion: 'test-1'
  });
}

function testFleet(name = 'test-fleet'): Fleet {
  return new Fleet(name, {
    namePrefix: 'test',
    environment: 'test',
    ssh: { port: 2222, allowedCidrs: ['192.0.2.0/24'] },
    hostnameStrategy: (node: HostnameSubject, domain: string) => `${node.id}.${domain}`
  });
}

function app(name: string, port: number) {
  return {
    name,
    dir: `/opt/${name}`,
    services: { app: { image: 'example.invalid/app@sha256:abc' } },
    files: [],
    deploySteps: [],
    endpoints: {
      [`${name}.http`]: {
        service: 'app',
        port,
        transport: 'tcp' as const,
        visibility: 'public' as const,
        scheme: 'http'
      }
    }
  };
}

function attachment(
  workloadName: string,
  overrides: Partial<Parameters<Node['attach']>[0]> = {}
): Parameters<Node['attach']>[0] {
  return {
    workloadName,
    hostname: `${workloadName}.example.test`,
    ingress: [],
    endpoints: {},
    paths: [`/opt/${workloadName}/docker-compose.yml`],
    containerNames: [],
    ...overrides
  };
}

function endpoint(id: string, port: number): ServiceEndpoint {
  const service = id.split('.')[0];
  return {
    id,
    owner: service,
    service,
    port,
    targetPort: port,
    transport: 'tcp',
    visibility: 'public',
    binding: 'host'
  };
}

class TestMachineProvider extends MachineProvider {
  public readonly providerName = 'test';
  public machineCreations = 0;
  public ingressRegistrations = 0;

  public constructor(name: string) {
    super('test:index:MachineProvider', name);
  }

  public createMachine(name: string, _args: MachineArgs, opts?: pulumi.ComponentResourceOptions): Machine {
    this.machineCreations += 1;
    const resource = new pulumi.ComponentResource('test:index:Machine', name, {}, opts);
    return {
      address: pulumi.output('192.0.2.10'),
      sshUsers: { cloudInit: 'root', deployment: 'root' },
      resource,
      addIngress: (ingressName: string, _ingress: MachineIngressArgs, ingressOpts?: pulumi.ResourceOptions) => {
        this.ingressRegistrations += 1;
        return [new pulumi.ComponentResource('test:index:Ingress', ingressName, {}, ingressOpts)];
      }
    };
  }
}

class TestNodeAddon extends Addon {
  public attachments = 0;

  public constructor(name: string) {
    super('test:index:NodeAddon', name, undefined, 'node');
  }

  public attachTo(_context: AddonAttachmentContext): HostAddonContribution {
    this.attachments += 1;
    return { name: 'shared-addon', services: {} };
  }
}
