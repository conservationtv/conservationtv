import { remote } from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import * as yaml from 'yaml';
import type { HostAddonContribution } from '../addons/types';
import type { SshAccessConfig } from '../config';
import type { Machine } from '../machine';
import { imageMutableReferenceWarning } from '../config';
import { sanitizeName } from '../naming';
import { mergeServiceEndpoints, type ServiceEndpoint } from '../endpoints';
import type { ComposeApp, ComposeRecord, ComposeServiceDefinition } from './composeTypes';
import { asRemoteScript, connectToRemoteHost, writeRemoteFileManifest, type RemoteFileSpec } from './remote';

export * from './composeTypes';

export interface ComposeHostArgs {
  machine: Machine;
  ssh: SshAccessConfig;
  sshPrivateKeyPem: pulumi.Input<string>;
  app: ComposeApp;
  addons?: HostAddonContribution[];
  deployAfter?: pulumi.Resource[];
}

export interface ComposeHostClaims {
  paths: string[];
  containerNames: string[];
}

export function composeHostClaims(app: ComposeApp, addons: readonly HostAddonContribution[] = []): ComposeHostClaims {
  const composeFile = `${app.dir}/docker-compose.yml`;
  const paths = [
    composeFile,
    ...app.files.map(file => file.path),
    ...(app.systemdUnits ?? []).map(unit => unit.path),
    ...addons.flatMap(addon => addon.files ?? []).map(file => file.path),
    ...addons.flatMap(addon => addon.systemdUnits ?? []).map(unit => unit.path)
  ];
  const services = [app.services, ...addons.map(addon => parseComposeRecord(addon.services))];
  const containerNames = services.flatMap(record =>
    Object.values(record).flatMap(service => {
      // Only mappings with a non-empty string container_name claim a container name.
      if (!service || Array.isArray(service) || !Object.hasOwn(service, 'container_name')) return [];
      const containerName = composeStringProperty(service, 'container_name');
      return containerName ? [containerName] : [];
    })
  );
  return { paths, containerNames };
}

export class ComposeHost extends pulumi.ComponentResource {
  public readonly deploySteps: ReadonlyMap<string, remote.Command>;
  public readonly completionResources: pulumi.Resource[];
  public readonly healthUrl?: string;
  public readonly endpoints: Readonly<Record<string, ServiceEndpoint>>;

  // Merge app and addon resources, reject collisions, and create deploy commands in dependency order.
  public constructor(name: string, args: ComposeHostArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:ComposeHost', name, {}, opts);
    validateApp(args.app);
    const addons = args.addons ?? [];
    const services = mergeComposeRecords(
      'service',
      args.app.services,
      addons.map(addon => parseComposeRecord(addon.services))
    );
    const volumes = mergeComposeRecords(
      'volume',
      args.app.volumes ?? {},
      addons.map(addon => parseComposeRecord(addon.volumes ?? {}))
    );
    this.endpoints = mergeServiceEndpoints([
      { owner: args.app.name, services: args.app.services, endpoints: args.app.endpoints },
      ...addons.map(addon => ({ owner: addon.name, services: addon.services, endpoints: addon.endpoints }))
    ]);
    warnForMutableImages(services, this);
    const composeFile = `${args.app.dir}/docker-compose.yml`;
    const compose = pulumi.output({ services, volumes }).apply(value => yaml.stringify(value));
    const unitFiles: RemoteFileSpec[] = [
      ...(args.app.systemdUnits ?? []),
      ...addons.flatMap(addon => addon.systemdUnits ?? [])
    ].map(unit => ({ path: unit.path, content: unit.content, permissions: unit.permissions ?? '0644' }));
    const files: RemoteFileSpec[] = [
      { path: composeFile, content: compose, permissions: '0600' },
      ...args.app.files,
      ...addons.flatMap(addon => addon.files ?? []),
      ...unitFiles
    ].map(file => ({
      ...file,
      content: pulumi.output(file.content).apply(content => content.replaceAll('{{composeFile}}', composeFile))
    }));
    assertUniquePaths(files);

    const host = connectToRemoteHost(
      name,
      {
        host: args.machine.address,
        ssh: args.ssh,
        sshPrivateKeyPem: args.sshPrivateKeyPem,
        cloudInitSshUser: args.machine.sshUsers.cloudInit,
        deploymentSshUser: args.machine.sshUsers.deployment
      },
      { parent: this, dependsOn: [args.machine.resource] }
    );
    const manifest = writeRemoteFileManifest(`${name}-files`, host, files, { parent: this });
    const commands = new Map<string, remote.Command>();
    const allSteps = [...addons.flatMap(addon => addon.deploySteps ?? []), ...args.app.deploySteps];
    for (const step of allSteps) {
      // Resolve dependencies only to earlier commands so missing or forward references fail before deployment.
      const stepName = sanitizeName(step.name);
      if (!stepName || commands.has(stepName)) throw new Error(`Duplicate or invalid deploy step "${step.name}".`);
      const namedDependencies = (step.dependsOnSteps ?? []).map(dependency => {
        const command = commands.get(sanitizeName(dependency));
        if (!command) throw new Error(`Deploy step "${step.name}" depends on unknown or later step "${dependency}".`);
        return command;
      });
      const script = pulumi
        .output(step.script)
        .apply(value => asRemoteScript(`set -eu\n${value.replaceAll('{{composeFile}}', composeFile)}`, host.needsSudo));
      const command = new remote.Command(
        `${name}-${stepName}`,
        {
          connection: host.connection,
          create: script,
          update: script,
          triggers: step.triggers
        },
        { parent: this, dependsOn: [manifest, ...(args.deployAfter ?? []), ...namedDependencies] }
      );
      commands.set(stepName, command);
    }
    this.deploySteps = commands;
    this.completionResources = [...commands.values()];
    this.healthUrl = args.app.healthUrl;
    this.registerOutputs({
      completionIds: this.completionResources.map(resource => resource.urn),
      healthUrl: this.healthUrl,
      endpoints: this.endpoints
    });
  }
}

export interface HealthCheckLoopArgs {
  url: string;
  attempts?: number;
  delaySeconds?: number;
  expectGrep?: HealthCheckExpectation;
  logsOnFailure?: string;
}
export interface HealthCheckExpectation {
  url: string;
  pattern: string;
}

// Apply retry defaults and optionally require a response pattern, emitting logs on the final failure.
export function healthCheckLoop(args: HealthCheckLoopArgs): string {
  const attempts = args.attempts ?? 30;
  const delay = args.delaySeconds ?? 1;
  const grep = args.expectGrep
    ? ` && curl -fsS --max-time 2 ${shellDoubleQuote(args.expectGrep.url)} | grep -q ${shellSingleQuote(args.expectGrep.pattern)}`
    : '';
  return dedent`
    for attempt in $(seq 1 ${attempts}); do
      if curl -fsS --max-time 2 ${shellDoubleQuote(args.url)} >/dev/null${grep}; then
        break
      fi
      if [ "$attempt" -eq ${attempts} ]; then
        ${args.logsOnFailure ?? 'true'}
        exit 1
      fi
      sleep ${delay}
    done
  `;
}

function validateApp(app: ComposeApp): void {
  if (sanitizeName(app.name) !== app.name)
    throw new Error(`Compose app name "${app.name}" must already be a sanitized name.`);
  if (!app.dir.startsWith('/')) throw new Error(`Compose app directory must be absolute: ${app.dir}`);
}

export function mergeComposeRecords(kind: string, base: ComposeRecord, additions: readonly ComposeRecord[]) {
  const result = { ...base };
  for (const addition of additions) {
    for (const [name, value] of Object.entries(addition)) {
      if (Object.hasOwn(result, name)) throw new Error(`Compose ${kind} name collision: "${name}".`);
      result[name] = value;
    }
  }
  return result;
}

function parseComposeRecord<T extends object>(record: T) {
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      if (value === null || Object(value) !== value) throw new Error(`Compose ${name} must be a YAML mapping.`);
      return [name, Object(value)];
    })
  ) satisfies ComposeRecord;
}

function composeStringProperty(value: ComposeServiceDefinition, name: string): string | undefined {
  const entry = Object.entries(value).find(([key]) => key === name)?.[1];
  if (entry === undefined) return undefined;
  const text = String(entry);
  return entry === text ? text : undefined;
}

function assertUniquePaths(files: readonly RemoteFileSpec[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`Remote file path collision: "${file.path}".`);
    paths.add(file.path);
  }
}

// Inspect service mappings for mutable image references and report warnings against the host resource.
function warnForMutableImages(services: ComposeRecord, parent: pulumi.Resource): void {
  for (const [name, value] of Object.entries(services)) {
    // Skip non-service values and missing images before checking whether the image reference is pinned.
    if (!value || Array.isArray(value) || !Object.hasOwn(value, 'image')) continue;
    const image = composeStringProperty(value, 'image');
    if (!image) continue;
    const warning = imageMutableReferenceWarning(image, `service ${name} image`);
    if (warning) pulumi.log.warn(warning, parent);
  }
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
