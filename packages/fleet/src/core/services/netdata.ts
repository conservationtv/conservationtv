import * as pulumi from '@pulumi/pulumi';
import { ComposeWorkload } from '../compose/workload';
import type { ComposeApp, DeploymentSummary, Machine } from '../contracts';

export interface NetdataAgentArgs {
  machines: Machine[];
  /** Defaults to `netdata/netdata:stable`. */
  image?: string;
}

/** A Netdata agent on each machine, reachable privately on port 19999. */
export class NetdataAgent extends pulumi.ComponentResource {
  public readonly summary: pulumi.Output<DeploymentSummary[]>;

  public constructor(name: string, args: NetdataAgentArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:NetdataAgent', name, {}, opts);
    const workload = new ComposeWorkload(
      name,
      {
        targets: args.machines.map(machine => ({ machine, hostname: machine.hostname })),
        app: netdataApp(args.image ?? 'netdata/netdata:stable')
      },
      { parent: this, dependsOn: opts?.dependsOn }
    );
    this.summary = workload.summary;
    this.registerOutputs({ summary: this.summary });
  }
}

function netdataApp(image: string): ComposeApp {
  return {
    name: 'netdata',
    services: {
      netdata: {
        image,
        container_name: 'netdata',
        pid: 'host',
        restart: 'unless-stopped',
        network_mode: 'host',
        pull_policy: 'always',
        cap_add: ['SYS_PTRACE', 'SYS_ADMIN'],
        security_opt: ['apparmor:unconfined'],
        volumes: [
          'netdataconfig:/etc/netdata',
          'netdatalib:/var/lib/netdata',
          'netdatacache:/var/cache/netdata',
          '/:/host/root:ro,rslave',
          '/etc/passwd:/host/etc/passwd:ro',
          '/etc/group:/host/etc/group:ro',
          '/etc/localtime:/etc/localtime:ro',
          '/proc:/host/proc:ro',
          '/sys:/host/sys:ro',
          '/etc/os-release:/host/etc/os-release:ro',
          '/var/log:/host/var/log:ro',
          '/var/run/docker.sock:/var/run/docker.sock:ro',
          '/run/dbus:/run/dbus:ro'
        ]
      }
    },
    volumes: { netdataconfig: {}, netdatalib: {}, netdatacache: {} },
    endpoints: {
      'netdata.http': {
        service: 'netdata',
        port: 19999,
        transport: 'tcp',
        visibility: 'private',
        scheme: 'http',
        paths: { info: '/api/v1/info' },
        description: 'Netdata node dashboard and API'
      }
    },
    health: [{ url: 'http://127.0.0.1:19999/api/v1/info' }]
  };
}
