import { LocalWorkspace, type ConfigMap, type Stack } from '@pulumi/pulumi/automation';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Opt-in: previews (or with FLEET_E2E_MODE=up, deploys and destroys) the controlplane stack, the package's real
 * consumer, against a local file backend. Requires real DigitalOcean, Cloudflare and ACME credentials.
 *
 *   FLEET_E2E=1 PULUMI_CONFIG_PASSPHRASE=... FLEET_E2E_CONFIG='{"controlplane:domain":{"value":"example.com"},...}'
 */
const enabled = process.env.FLEET_E2E === '1';
const repositoryRoot = path.resolve(__dirname, '../../..');
const stackDir = path.join(repositoryRoot, 'apps/controlplane/infrastructure');
const stateDir = path.resolve(process.env.FLEET_E2E_STATE_DIR ?? path.join(repositoryRoot, '.pulumi-e2e'));

describe('controlplane stack (Automation API, file backend)', () => {
  (enabled ? it : it.skip)('previews or deploys MoQ and Iroh relays', async () => {
    const passphrase = process.env.PULUMI_CONFIG_PASSPHRASE;
    if (!passphrase)
      throw new Error('FLEET_E2E=1 requires PULUMI_CONFIG_PASSPHRASE for local-state secret encryption.');
    const config = readConfig();
    // The stack runs compiled JavaScript against the built package.
    execFileSync('pnpm', ['run', 'build'], { cwd: stackDir, stdio: 'inherit' });
    await mkdir(stateDir, { recursive: true });
    const stack = await LocalWorkspace.createOrSelectStack(
      { stackName: process.env.FLEET_E2E_STACK ?? 'e2e', workDir: stackDir },
      { envVars: { PULUMI_BACKEND_URL: `file://${stateDir}`, PULUMI_CONFIG_PASSPHRASE: passphrase } }
    );
    await stack.setAllConfig(config);

    if ((process.env.FLEET_E2E_MODE ?? 'preview') === 'preview') {
      const preview = await stack.preview({ onOutput: log });
      expect(preview.changeSummary).toBeDefined();
      return;
    }
    try {
      const { outputs } = await stack.up({ onOutput: log });
      for (const name of ['gatekeeperSecrets', 'moqDirectory', 'irohDirectory', 'sshConfig', 'sshPrivateKey']) {
        expect(outputs).toHaveProperty(name);
      }
      expect(outputs.sshPrivateKey.secret).toBe(true);
      expect(outputs.gatekeeperSecrets.secret).toBe(true);
    } finally {
      if (process.env.FLEET_E2E_KEEP !== '1') await destroy(stack);
    }
  });
});

// FLEET_E2E_CONFIG is a Pulumi ConfigMap: config keys mapped to `{ "value": string, "secret"?: boolean }`.
function readConfig(): ConfigMap {
  const raw = process.env.FLEET_E2E_CONFIG;
  if (!raw)
    throw new Error('FLEET_E2E_CONFIG must be JSON mapping Pulumi config keys to {"value":"...","secret":boolean}.');
  return JSON.parse(raw);
}

async function destroy(stack: Stack): Promise<void> {
  await stack.destroy({ onOutput: log });
  await stack.workspace.removeStack(stack.name);
}

function log(line: string): void {
  process.stdout.write(`[pulumi] ${line}\n`);
}
