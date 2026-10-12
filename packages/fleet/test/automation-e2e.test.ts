import { LocalWorkspace, type ConfigMap, type Stack } from '@pulumi/pulumi/automation';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type E2eMode = 'preview' | 'up';
interface ParsedJsonObject {
  [key: string]: ParsedJsonValue;
}
type ParsedJsonValue = string | boolean | null | ParsedJsonValue[] | ParsedJsonObject;

const enabled = process.env.FLEET_E2E === '1';
const target = process.env.FLEET_E2E_TARGET ?? 'all';
const minimalIt = enabled && (target === 'all' || target === 'minimal') ? it : it.skip;
const fullIt = enabled && (target === 'all' || target === 'full') ? it : it.skip;
const repositoryRoot = path.resolve(__dirname, '../../..');
const stateDir = path.resolve(process.env.FLEET_E2E_STATE_DIR ?? path.join(repositoryRoot, '.pulumi-e2e'));

describe('Automation API examples (file backend + passphrase secrets)', () => {
  minimalIt('previews or deploys the minimal generic fleet', async () => {
    await runExample({
      example: 'minimal',
      stackName: process.env.FLEET_E2E_MINIMAL_STACK ?? 'e2e-minimal',
      configEnvironmentKey: 'FLEET_E2E_MINIMAL_CONFIG',
      expectedOutputs: ['summary', 'sshConfig', 'sshPrivateKey']
    });
  });

  fullIt('previews or deploys the MoQ + Iroh component fleet', async () => {
    await runExample({
      example: 'moq-iroh-fleet',
      stackName: process.env.FLEET_E2E_FULL_STACK ?? 'e2e-moq-iroh',
      configEnvironmentKey: 'FLEET_E2E_FULL_CONFIG',
      expectedOutputs: ['moqDirectory', 'irohDirectory', 'irohRelayUrls', 'summary', 'sshConfig', 'sshPrivateKey']
    });
  });
});

interface RunExampleArgs {
  example: string;
  stackName: string;
  configEnvironmentKey: 'FLEET_E2E_MINIMAL_CONFIG' | 'FLEET_E2E_FULL_CONFIG';
  expectedOutputs: string[];
}

// Preview without deploying, or deploy and verify outputs with cleanup unless explicitly retained.
async function runExample(args: RunExampleArgs): Promise<void> {
  const passphrase = process.env.PULUMI_CONFIG_PASSPHRASE;
  if (!passphrase) throw new Error('FLEET_E2E=1 requires PULUMI_CONFIG_PASSPHRASE for local-state secret encryption.');
  const config = parseConfig(args.configEnvironmentKey);
  const mode = readMode();
  await mkdir(stateDir, { recursive: true });
  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName: args.stackName, workDir: path.join(repositoryRoot, 'examples', args.example) },
    {
      envVars: {
        PULUMI_BACKEND_URL: `file://${stateDir}`,
        PULUMI_CONFIG_PASSPHRASE: passphrase
      }
    }
  );
  await stack.setAllConfig(config);

  if (mode === 'preview') {
    const preview = await stack.preview({ onOutput: logPulumiOutput });
    expect(preview.changeSummary).toBeDefined();
    return;
  }

  try {
    const result = await stack.up({ onOutput: logPulumiOutput });
    const outputs = result.outputs;
    for (const expectedOutput of args.expectedOutputs) expect(outputs).toHaveProperty(expectedOutput);
    expect(outputs.sshPrivateKey?.secret).toBe(true);
  } finally {
    if (process.env.FLEET_E2E_KEEP !== '1') await destroyAndRemove(stack);
  }
}

// Require a config object whose entries contain string values and optionally a boolean secret flag.
function parseConfig(environmentKey: RunExampleArgs['configEnvironmentKey']): ConfigMap {
  const value = process.env[environmentKey];
  if (!value) {
    throw new Error(`${environmentKey} must be JSON mapping Pulumi config keys to {"value":"...","secret":boolean}.`);
  }
  const parsed: ParsedJsonValue = JSON.parse(value);
  if (!isJsonObject(parsed)) throw new Error(`${environmentKey} must be a JSON object.`);
  const config: ConfigMap = {};
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (!isJsonObject(rawValue)) throw new Error(`${environmentKey} values must be objects.`);
    const configValue = readString(rawValue, 'value');
    if (configValue === undefined) throw new Error(`${environmentKey} values require a string value.`);
    const secret = readBoolean(rawValue, 'secret');
    config[key] = secret === undefined ? { value: configValue } : { value: configValue, secret };
  }
  return config;
}

function isJsonObject(value: ParsedJsonValue): value is ParsedJsonObject {
  return value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function readString(value: ParsedJsonObject, key: string): string | undefined {
  const property = Object.getOwnPropertyDescriptor(value, key)?.value;
  return property !== undefined && Object.prototype.toString.call(property) === '[object String]'
    ? String(property)
    : undefined;
}

function readBoolean(value: ParsedJsonObject, key: string): boolean | undefined {
  const property = Object.getOwnPropertyDescriptor(value, key)?.value;
  return property === true || property === false ? property : undefined;
}

function readMode(): E2eMode {
  const value = process.env.FLEET_E2E_MODE ?? 'preview';
  if (value !== 'preview' && value !== 'up') throw new Error('FLEET_E2E_MODE must be preview or up.');
  return value;
}

async function destroyAndRemove(stack: Stack): Promise<void> {
  await stack.destroy({ onOutput: logPulumiOutput });
  await stack.workspace.removeStack(stack.name);
}

function logPulumiOutput(line: string): void {
  process.stdout.write(`[pulumi] ${line}\n`);
}
