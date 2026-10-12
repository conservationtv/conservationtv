/**
 * Credential checks that fail fast with a readable message before a provider errors mid-deployment.
 * Values are looked up in `config`, then `env`, then `process.env`.
 */
export interface PreflightOptions {
  skip?: boolean;
  env?: NodeJS.ProcessEnv;
  config?: Readonly<Record<string, unknown>>;
}

function valueOf(key: string, options: PreflightOptions): unknown {
  return options.config?.[key] ?? options.env?.[key] ?? process.env[key];
}

function present(key: string, options: PreflightOptions): boolean {
  const value = valueOf(key, options);
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(provider: string, problems: readonly string[]): void {
  if (problems.length) throw new Error(`${provider} preflight failed:\n${problems.map(p => `- ${p}`).join('\n')}`);
}

export function preflightDigitalOcean(options: PreflightOptions = {}): void {
  if (options.skip) return;
  if (present('DIGITALOCEAN_TOKEN', options) || present('digitalocean:token', options)) return;
  fail('DigitalOcean', ['DIGITALOCEAN_TOKEN or digitalocean:token is required.']);
}

export function preflightOpenStack(options: PreflightOptions = {}): void {
  if (options.skip) return;
  const problems = ['OS_AUTH_URL', 'OS_REGION_NAME']
    .filter(key => !present(key, options))
    .map(key => `${key} is required.`);
  const authUrl = valueOf('OS_AUTH_URL', options);
  if (typeof authUrl === 'string' && authUrl.trim() && !/^https?:\/\//.test(authUrl)) {
    problems.push('OS_AUTH_URL must be an absolute HTTP(S) URL.');
  }
  const applicationCredential =
    present('OS_APPLICATION_CREDENTIAL_ID', options) && present('OS_APPLICATION_CREDENTIAL_SECRET', options);
  const passwordCredential =
    present('OS_USERNAME', options) &&
    present('OS_PASSWORD', options) &&
    (present('OS_PROJECT_ID', options) || present('OS_PROJECT_NAME', options));
  if (!applicationCredential && !passwordCredential) {
    problems.push(
      'Set OS_APPLICATION_CREDENTIAL_ID + OS_APPLICATION_CREDENTIAL_SECRET, ' +
        'or OS_USERNAME + OS_PASSWORD + OS_PROJECT_ID/OS_PROJECT_NAME.'
    );
  }
  fail('OpenStack', problems);
}

export function preflightCloudflare(options: PreflightOptions = {}): void {
  if (options.skip) return;
  const keys = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_DNS_API_TOKEN', 'cloudflare:apiToken'];
  if (keys.some(key => present(key, options))) return;
  fail('Cloudflare', [`${keys.join(', ')} is required.`]);
}
