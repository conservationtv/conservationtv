import * as pulumi from '@pulumi/pulumi';
import { beforeEach, describe, expect, it } from 'vitest';
import { ComposeDeployment } from '../src/core/compose/deployment';
import { ComposeWorkload } from '../src/core/compose/workload';
import type { ComposeApp, ComposeWorkloadArgs, Machine, WorkloadTarget } from '../src/core/contracts';
import { MachineClaimLedger } from '../src/core/machines/claims';

interface CommandInputs {
  create: string;
  triggers: string[];
}

const inputs = new Map<string, CommandInputs>();

pulumi.runtime.setMocks({
  newResource: args => {
    inputs.set(args.name, args.inputs);
    return { id: `${args.name}-id`, state: args.inputs };
  },
  call: args => args.inputs
});

interface Registration {
  resource: pulumi.Resource;
  type: string;
  name: string;
  opts: pulumi.ResourceOptions;
}

let registrations: Registration[] = [];

beforeEach(() => {
  registrations = [];
  inputs.clear();
});

// Transformations are inherited by every descendant, so this sees exactly what each child was given.
const record: pulumi.ResourceTransformation = ({ resource, type, name, opts }) => {
  registrations.push({ resource, type, name, opts });
  return undefined;
};

describe('compose workloads on shared machines', () => {
  it('gives each workload its own ingress on a shared machine without collisions', async () => {
    const machine = fakeMachine('shared');
    const one = workload('one', { targets: [target(machine, 'one')], app: app('one', 8081) });
    const two = workload('two', { targets: [target(machine, 'two')], app: app('two', 8082) });
    await settle();

    const ingress = registrations.filter(registration => registration.type === 'fleet:core:MachineIngress');
    expect(ingress.map(registration => registration.name)).toEqual(['one-shared-ingress', 'two-shared-ingress']);
    expect(one.deployments[0].endpoints['one.http']).toMatchObject({ owner: 'one', port: 8081 });
    expect(await promiseOf(two.summary)).toEqual([
      {
        machine: 'shared',
        provider: 'test',
        region: 'test-1',
        hostname: 'two.example.test',
        address: '192.0.2.10',
        endpoints: two.deployments[0].endpoints
      }
    ]);
  });

  it('rejects listeners, paths and container names claimed by another workload', () => {
    const listener = fakeMachine('listener');
    workload('one', { targets: [target(listener, 'one')], app: app('one', 8080) });
    expect(() => workload('two', { targets: [target(listener, 'two')], app: app('two', 8080) })).toThrow(
      /listener "tcp:8080" is claimed by both "one-listener" and "two-listener"/
    );

    const path = fakeMachine('path');
    workload('one', { targets: [target(path, 'one')], app: app('same', 8081) });
    expect(() => workload('two', { targets: [target(path, 'two')], app: app('same', 8082) })).toThrow(
      /path "\/opt\/same\/docker-compose.yml"/
    );

    const container = fakeMachine('container');
    const named = (name: string, port: number): ComposeApp => {
      const base = app(name, port);
      return { ...base, services: { app: { ...base.services.app, container_name: 'shared' } } };
    };
    workload('one', { targets: [target(container, 'one')], app: named('one', 8081) });
    expect(() => workload('two', { targets: [target(container, 'two')], app: named('two', 8082) })).toThrow(
      /container "shared"/
    );
  });
});

describe('rollout ordering', () => {
  it('makes each serial deployment wait for the previous one and orders by priority', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(id => fakeMachine(id));
    const serial = workload('serial', {
      targets: [target(a, 'a', 1), target(c, 'c'), target(b, 'b')],
      app: app('web', 8080),
      rollout: 'serial'
    });
    await settle();

    expect(serial.deployments.map(deployment => deployment.target.machine.id)).toEqual(['b', 'c', 'a']);
    const [first, second, third] = serial.deployments;
    expect(dependencies('serial-b')).not.toContain(first);
    expect(dependencies('serial-c')).toContain(first);
    expect(dependencies('serial-a')).toContain(second);
    // The predecessor is a component, so depending on it waits for all of its commands and health gates.
    expect(dependencies('serial-a-redeploy')).toContain(second);
    expect(dependencies('serial-a-files')).not.toContain(third);
  });

  it('runs parallel deployments independently', async () => {
    const parallel = workload('parallel', {
      targets: [target(fakeMachine('a'), 'a'), target(fakeMachine('b'), 'b')],
      app: app('web', 8080)
    });
    await settle();
    expect(dependencies('parallel-b-files')).not.toContain(parallel.deployments[0]);
  });

  it('forwards a workload dependsOn to every remote command', async () => {
    const upstream = new pulumi.ComponentResource('test:index:Upstream', 'upstream');
    workload(
      'gated',
      { targets: [target(fakeMachine('a'), 'a'), target(fakeMachine('b'), 'b')], app: app('web', 8080, true) },
      { dependsOn: [upstream] }
    );
    await settle();
    const commands = registrations.filter(registration => registration.type === 'command:remote:Command');
    expect(commands.map(command => command.name)).toEqual([
      'gated-a-files',
      'gated-a-redeploy',
      'gated-a-restart',
      'gated-a-step-migrate',
      'gated-b-files',
      'gated-b-redeploy',
      'gated-b-restart',
      'gated-b-step-migrate'
    ]);
    for (const { name } of commands) expect(dependencies(name)).toContain(upstream);
  });

  it('validates targets', () => {
    const machine = fakeMachine('one');
    expect(() => workload('empty', { targets: [], app: app('web', 8080) })).toThrow(/at least one target/);
    expect(() =>
      workload('twice', { targets: [target(machine, 'a'), target(machine, 'b')], app: app('web', 8080) })
    ).toThrow(/targets machine "one" twice/);
    expect(() =>
      workload('dup', {
        targets: [target(fakeMachine('a'), 'same'), { machine: fakeMachine('b'), hostname: 'SAME.example.test.' }],
        app: app('web', 8080)
      })
    ).toThrow(/hostname "same.example.test" twice/);
  });
});

describe('managed lifecycle', () => {
  it('writes files, redeploys, restarts on restart files only, then runs steps', async () => {
    new ComposeDeployment(
      'life',
      { target: target(fakeMachine('m', true), 'life'), app: app('web', 8080, true) },
      { transformations: [record] }
    );
    new ComposeDeployment(
      'renewed',
      { target: target(fakeMachine('n', true), 'renewed'), app: app('web', 8080, true, 'RENEWED KEY') },
      { transformations: [record] }
    );
    await settle();

    const files = command('life-files').create;
    expect(files).toMatch(/^sudo \/bin\/sh -s <<'__FLEET_SUDO__'/);
    for (const path of ['/opt/web/docker-compose.yml', '/etc/systemd/system/web.service', '/opt/web/certs/key.pem']) {
      expect(files).toContain(`base64 -d > '${path}'`);
    }
    expect(files).toContain("chmod 0600 '/opt/web/docker-compose.yml'");

    const redeploy = command('life-redeploy');
    expect(redeploy.create).toContain("cd '/opt/web'");
    expect(redeploy.create).toContain('docker compose up -d --force-recreate --remove-orphans');
    expect(redeploy.create).toContain("curl -fsS --max-time 2 'http://127.0.0.1:8080/health' | grep -Eq '^ok$'");
    expect(redeploy.create).toContain('docker compose logs --tail=100');

    const restart = command('life-restart');
    expect(restart.create).toContain('docker compose restart');
    // A changed restart-only file (a renewed key) restarts in place without triggering a redeploy.
    expect(command('renewed-redeploy').triggers).toEqual(redeploy.triggers);
    expect(command('renewed-restart').triggers).not.toEqual(restart.triggers);
    expect(dependencies('life-restart')).toContain(resourceNamed('life-redeploy'));
    expect(dependencies('life-step-migrate')).toContain(resourceNamed('life-restart'));

    const [, encodedCompose = ''] = /docker-compose.yml'.*?\n(.*?)\n__FLEET_FILE__/s.exec(files) ?? [];
    const compose = Buffer.from(encodedCompose, 'base64');
    expect(compose.toString()).toMatch(/^name: web\nservices:\n {2}app:/);
  });

  it('rejects malformed apps', () => {
    const reject = (overrides: Partial<ComposeApp>, message: RegExp) =>
      expect(
        () =>
          new ComposeDeployment('bad', {
            target: target(fakeMachine('m'), 'bad'),
            app: { ...app('web', 80), ...overrides }
          })
      ).toThrow(message);
    reject({ name: 'Web App' }, /sanitized name/);
    reject({ dir: 'opt/web' }, /absolute path/);
    reject({ files: [{ path: 'docker-compose.yml', content: 'x' }] }, /more than once/);
    reject({ files: [{ path: 'a', content: 'x', mode: '999' }] }, /invalid mode/);
    reject({ steps: [{ name: 'Not ok', script: 'true', triggers: [] }] }, /step "Not ok"/);
    reject({ health: [{ url: 'localhost:80' }] }, /HTTP\(S\) URL/);
  });
});

function workload(name: string, args: ComposeWorkloadArgs, opts: pulumi.ComponentResourceOptions = {}) {
  return new ComposeWorkload(name, args, { ...opts, transformations: [record] });
}

function app(name: string, port: number, full = false, key = 'KEY'): ComposeApp {
  return {
    name,
    services: { app: { image: 'example.invalid/app@sha256:abc' } },
    endpoints: {
      [`${name}.http`]: { service: 'app', port, transport: 'tcp', visibility: 'public', scheme: 'http' }
    },
    ...(full && {
      files: [
        { path: 'app.toml', content: 'mode = 1' },
        { path: 'certs/key.pem', content: key, mode: '0600', onChange: 'restart' }
      ],
      health: [{ url: `http://127.0.0.1:${port}/health`, expect: '^ok$' }],
      steps: [{ name: 'migrate', script: 'docker compose exec app migrate', triggers: ['v1'] }]
    })
  };
}

function target(machine: Machine, label: string, priority?: number): WorkloadTarget {
  return { machine, hostname: `${label}.example.test`, priority };
}

function fakeMachine(id: string, sudo = false): Machine {
  return {
    id,
    displayName: id,
    provider: 'test',
    region: 'test-1',
    hostname: `${id}.machines.example.test`,
    address: pulumi.output('192.0.2.10'),
    connection: pulumi.output({ host: '192.0.2.10', user: 'deploy' }),
    sudo,
    ready: new pulumi.ComponentResource('test:index:Ready', `${id}-${Math.random()}`),
    firewall: { kind: 'openstack', securityGroupId: pulumi.output(`${id}-sg`), region: 'test-1' },
    claims: new MachineClaimLedger(id)
  };
}

function dependencies(name: string): pulumi.Resource[] {
  const dependsOn = registrations.find(registration => registration.name === name)?.opts.dependsOn;
  return [dependsOn].flat(Infinity).filter(pulumi.Resource.isInstance);
}

function command(name: string): CommandInputs {
  const recorded = inputs.get(name);
  if (!recorded) throw new Error(`No command named ${name} was registered.`);
  return recorded;
}

function resourceNamed(name: string): pulumi.Resource | undefined {
  return registrations.find(registration => registration.name === name)?.resource;
}

function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise(resolve => output.apply(resolve));
}

async function settle(): Promise<void> {
  await Promise.all(registrations.map(registration => promiseOf(registration.resource.urn)));
}
