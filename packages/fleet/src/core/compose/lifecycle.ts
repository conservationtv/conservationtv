import { posix } from 'node:path';
import { remote, type types as commandTypes } from '@pulumi/command';
import * as pulumi from '@pulumi/pulumi';
import * as yaml from 'yaml';
import type { ComposeApp, ComposeMapping, ComposeValue, FileChangePolicy, HealthCheck, RemoteFile } from '../contracts';
import { sanitizeName } from '../naming';
import { shellQuote } from '../shell';
import { mutableImageWarning } from '../validate';

const COMPOSE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const FILE_MODE = /^0?[0-7]{3}$/;
const HEALTH_ATTEMPTS = 30;

interface ManagedFile {
  /** Absolute. */
  path: string;
  content: pulumi.Input<string>;
  mode: string;
  onChange: FileChangePolicy;
}

/** Everything the managed lifecycle will do for an app, decided at plan time. */
interface ComposePlan {
  name: string;
  dir: string;
  /** The compose file, the systemd unit, then the app's own files. */
  files: ManagedFile[];
  containerNames: string[];
  warnings: string[];
  health: HealthCheck[];
  steps: NonNullable<ComposeApp['steps']>;
}

interface RemoteTarget {
  connection: pulumi.Input<commandTypes.input.remote.ConnectionArgs>;
  sudo: boolean;
}

/** Validates `app` and decides, at plan time, every file, claim and check the lifecycle will use. */
export function planComposeApp(app: ComposeApp): ComposePlan {
  const dir = appDir(app);
  if (!Object.keys(app.services).length) throw new Error(`Compose app "${app.name}" declares no services.`);
  assertComposeNames(app.name, 'service', app.services);
  assertComposeNames(app.name, 'volume', app.volumes ?? {});
  assertStepNames(app);
  for (const check of app.health ?? []) assertHealthUrl(app.name, check.url);

  const services = Object.entries(app.services);
  return {
    name: app.name,
    dir,
    files: managedFiles(app, dir),
    containerNames: services.flatMap(([, service]) => plainString(service.container_name) ?? []),
    warnings: services.flatMap(([service, definition]) => {
      const image = plainString(definition.image);
      return (image && mutableImageWarning(image, `Compose app "${app.name}" service "${service}"`)) || [];
    }),
    health: app.health ?? [],
    steps: app.steps ?? []
  };
}

/** The app's absolute directory (default `/opt/<name>`), after checking the name is already sanitized. */
function appDir(app: ComposeApp): string {
  if (!app.name || sanitizeName(app.name) !== app.name) {
    throw new Error(`Compose app name "${app.name}" must already be a sanitized name.`);
  }
  const dir = app.dir ?? `/opt/${app.name}`;
  if (!posix.isAbsolute(dir) || posix.normalize(dir) === '/') {
    throw new Error(`Compose app "${app.name}" directory must be an absolute path below /, got "${dir}".`);
  }
  return dir;
}

// The compose file and unit come first so they are always redeploy triggers; app paths resolve against `dir`.
function managedFiles(app: ComposeApp, dir: string): ManagedFile[] {
  const compose = pulumi
    .output({ name: app.name, services: app.services, volumes: app.volumes })
    .apply(value => yaml.stringify(value));
  const files: ManagedFile[] = [
    { path: posix.join(dir, 'docker-compose.yml'), content: compose, mode: '0600', onChange: 'redeploy' },
    {
      path: `/etc/systemd/system/${app.name}.service`,
      content: systemdUnit(app.name, dir),
      mode: '0644',
      onChange: 'redeploy'
    },
    ...(app.files ?? []).map(file => appFile(app.name, dir, file))
  ];
  const paths = new Set<string>();
  for (const { path } of files) {
    if (paths.has(path)) throw new Error(`Compose app "${app.name}" writes "${path}" more than once.`);
    paths.add(path);
  }
  return files;
}

function appFile(app: string, dir: string, file: RemoteFile): ManagedFile {
  const mode = file.mode ?? '0644';
  if (!FILE_MODE.test(mode)) throw new Error(`Compose app "${app}" file "${file.path}" has invalid mode ${mode}.`);
  return { path: posix.resolve(dir, file.path), content: file.content, mode, onChange: file.onChange ?? 'redeploy' };
}

/** Step names become resource names, so each must be sanitized and unique within the app. */
function assertStepNames(app: ComposeApp): void {
  const names = new Set<string>();
  for (const { name } of app.steps ?? []) {
    if (!name || sanitizeName(name) !== name || names.has(name)) {
      throw new Error(`Compose app "${app.name}" step "${name}" must be a unique, sanitized name.`);
    }
    names.add(name);
  }
}

/**
 * Create the remote commands for a planned app, all under `opts` (which carries the parent and
 * every upstream dependency). Resource names and trigger sets:
 * - `${name}-files`: writes every file in one script; re-runs whenever any content, path or mode changes.
 * - `${name}-redeploy`: daemon-reload, enable the unit, pull, recreate, health gate; triggered by every
 *   `redeploy` file (always including the compose file and unit).
 * - `${name}-restart`: only when the app has `restart` files; restart in place, health gate; triggered
 *   by those files only, after the redeploy.
 * - `${name}-step-${step.name}`: each step in order, after everything above.
 */
export function deployComposePlan(
  name: string,
  plan: ComposePlan,
  target: RemoteTarget,
  opts: pulumi.CustomResourceOptions
): remote.Command[] {
  const after = (...resources: pulumi.Resource[]) => pulumi.mergeOptions(opts, { dependsOn: resources });
  const command = (
    suffix: string,
    script: pulumi.Input<string>,
    triggers: pulumi.Input<unknown>[],
    deps: remote.Command[]
  ) => {
    const remoteScript = pulumi.output(script).apply(body => asRemoteScript(body, target.sudo));
    return new remote.Command(
      `${name}-${suffix}`,
      { connection: target.connection, create: remoteScript, update: remoteScript, triggers },
      after(...deps)
    );
  };
  const contentsFor = (policy: FileChangePolicy) =>
    plan.files.filter(file => file.onChange === policy).map(file => file.content);

  const files = command('files', fileManifest(plan.files), [], []);
  const health = healthGate(plan.health);
  const redeploy = command(
    'redeploy',
    inDir(
      plan.dir,
      [
        'systemctl daemon-reload',
        `systemctl enable ${shellQuote(`${plan.name}.service`)}`,
        'docker compose pull',
        'docker compose up -d --force-recreate --remove-orphans',
        health
      ].join('\n')
    ),
    contentsFor('redeploy'),
    [files]
  );
  const lifecycle = [files, redeploy];
  const restartContents = contentsFor('restart');
  if (restartContents.length) {
    lifecycle.push(
      command('restart', inDir(plan.dir, `docker compose restart\n${health}`), restartContents, [files, redeploy])
    );
  }
  for (const step of plan.steps) {
    const script = pulumi.output(step.script).apply(body => inDir(plan.dir, body));
    lifecycle.push(command(`step-${step.name}`, script, step.triggers, [...lifecycle]));
  }
  return lifecycle;
}

// No ExecStartPre pull: deploys pull explicitly, and a boot should not wait on (or fail with) a registry.
function systemdUnit(name: string, dir: string): string {
  return `[Unit]
Description=${name} (Docker Compose)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${dir}
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose stop
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
`;
}

// One script for every file, so a redeploy never observes a partially written app. umask keeps
// secret files private until chmod sets their final mode.
function fileManifest(files: readonly ManagedFile[]): pulumi.Output<string> {
  return pulumi
    .all(files.map(file => file.content))
    .apply(contents =>
      [
        'set -eu',
        'umask 077',
        ...files.map((file, index) =>
          [
            `install -m 0755 -d ${shellQuote(posix.dirname(file.path))}`,
            `base64 -d > ${shellQuote(file.path)} <<'__FLEET_FILE__'`,
            Buffer.from(contents[index], 'utf8').toString('base64'),
            '__FLEET_FILE__',
            `chmod ${file.mode} ${shellQuote(file.path)}`
          ].join('\n')
        )
      ].join('\n')
    );
}

function healthGate(checks: readonly HealthCheck[]): string {
  return checks
    .map(check => {
      const fetch = `curl -fsS --max-time 2 ${shellQuote(check.url)}`;
      const probe = check.expect ? `${fetch} | grep -Eq ${shellQuote(check.expect)}` : `${fetch} >/dev/null`;
      return `attempt=1
until ${probe}; do
  if [ "$attempt" -ge ${HEALTH_ATTEMPTS} ]; then
    echo ${shellQuote(`Health check failed: ${check.url}`)} >&2
    docker compose logs --tail=100
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done`;
    })
    .join('\n');
}

function inDir(dir: string, script: string): string {
  return `set -eu\ncd ${shellQuote(dir)}\n${script}`;
}

function asRemoteScript(script: string, sudo: boolean): string {
  return sudo ? `sudo /bin/sh -s <<'__FLEET_SUDO__'\n${script.trim()}\n__FLEET_SUDO__\n` : script;
}

/** Service and volume names must be compose keys and their definitions mappings. */
function assertComposeNames(app: string, kind: string, record: Record<string, ComposeMapping>): void {
  for (const [name, value] of Object.entries(record)) {
    // Values are typed as mappings, but a stack may build them from untyped config; fail here, not on the host.
    if (!COMPOSE_NAME.test(name)) throw new Error(`Compose app "${app}" ${kind} name "${name}" is invalid.`);
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- guards untyped callers; the contract says mapping.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Compose app "${app}" ${kind} "${name}" must be a mapping.`);
    }
  }
}

function assertHealthUrl(app: string, url: string): void {
  const protocol = URL.parse(url)?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Compose app "${app}" health check URL must be an absolute HTTP(S) URL, got "${url}".`);
  }
}

/** The value when it is a plain string; Pulumi inputs are unknown at plan time and yield undefined. */
function plainString(value: ComposeValue | undefined): string | undefined {
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- compose values may be Outputs, which plan-time checks skip.
  return typeof value === 'string' ? value : undefined;
}
