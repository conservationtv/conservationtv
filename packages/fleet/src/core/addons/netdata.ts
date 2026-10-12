import type * as pulumi from '@pulumi/pulumi';
import { healthCheckLoop } from '../host/composeHost';
import { Addon, type HostAddonContribution } from './types';

export interface NetdataAddonArgs {
  image?: string;
}

export const NETDATA_HTTP_ENDPOINT = 'netdata.http';

export class NetdataAddon extends Addon {
  private readonly image: string;

  public constructor(name: string, args: NetdataAddonArgs = {}, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:NetdataAddon', name, opts, 'node');
    this.image = args.image ?? 'netdata/netdata:stable';
    this.registerOutputs({ image: this.image });
  }

  public attachTo(): HostAddonContribution {
    return {
      name: 'netdata',
      services: {
        netdata: {
          image: this.image,
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
        [NETDATA_HTTP_ENDPOINT]: {
          service: 'netdata',
          port: 19999,
          transport: 'tcp',
          visibility: 'private',
          scheme: 'http',
          paths: { info: '/api/v1/info' },
          description: 'Netdata node dashboard and API'
        }
      },
      deploySteps: [
        {
          name: 'deploy-netdata',
          script: `docker compose -f {{composeFile}} up -d --remove-orphans netdata
${healthCheckLoop({
  url: 'http://127.0.0.1:19999/api/v1/info',
  logsOnFailure: 'docker compose -f {{composeFile}} logs --tail=100 netdata'
})}`,
          triggers: [this.image]
        }
      ]
    };
  }
}
