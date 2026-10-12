import { assertPreflight, collectPreflightIssues, type PreflightOptions, type PreflightValue } from './preflightCore';

// Prefer explicit config, then the supplied environment, then process environment values.
const valueOf = (key: string, options: PreflightOptions): PreflightValue | undefined =>
  options.config?.[key] ?? options.env?.[key] ?? process.env[key];

function present(value: PreflightValue | undefined): value is string {
  return value === String(value) && value.trim().length > 0;
}

// Accept either token naming convention unless credential checks were explicitly skipped.
export function preflightDigitalOcean(options: PreflightOptions = {}): void {
  if (
    options.skipPreflight ||
    present(valueOf('DIGITALOCEAN_TOKEN', options)) ||
    present(valueOf('digitalocean:token', options))
  )
    return;
  assertPreflight('DigitalOcean', [
    { key: 'DIGITALOCEAN_TOKEN', message: 'DIGITALOCEAN_TOKEN or digitalocean:token is required.' }
  ]);
}

// Require auth URL and region plus either a complete application credential or password credential.
export function preflightOpenStack(options: PreflightOptions = {}): void {
  if (options.skipPreflight) return;
  const issues = collectPreflightIssues(['OS_AUTH_URL', 'OS_REGION_NAME'], options);
  if (!hasOpenStackApplicationCredential(options) && !hasOpenStackPasswordCredential(options)) {
    issues.push({
      key: 'OS_CREDENTIALS',
      message:
        'Set OS_APPLICATION_CREDENTIAL_ID + OS_APPLICATION_CREDENTIAL_SECRET, or OS_USERNAME + OS_PASSWORD + OS_PROJECT_ID/OS_PROJECT_NAME.'
    });
  }
  const authUrl = valueOf('OS_AUTH_URL', options);
  if (present(authUrl) && !/^https?:\/\//.test(authUrl)) {
    issues.push({ key: 'OS_AUTH_URL', message: 'OS_AUTH_URL must be an absolute HTTP(S) URL.' });
  }
  assertPreflight('OpenStack', issues);
}

function hasOpenStackApplicationCredential(options: PreflightOptions): boolean {
  return (
    present(valueOf('OS_APPLICATION_CREDENTIAL_ID', options)) &&
    present(valueOf('OS_APPLICATION_CREDENTIAL_SECRET', options))
  );
}

function hasOpenStackPasswordCredential(options: PreflightOptions): boolean {
  const hasProject = present(valueOf('OS_PROJECT_ID', options)) || present(valueOf('OS_PROJECT_NAME', options));
  return present(valueOf('OS_USERNAME', options)) && present(valueOf('OS_PASSWORD', options)) && hasProject;
}

// Accept any supported Cloudflare token variable, reporting missing credentials unless checks are skipped.
export function preflightCloudflare(options: PreflightOptions = {}): void {
  const token =
    present(valueOf('CLOUDFLARE_API_TOKEN', options)) ||
    present(valueOf('CLOUDFLARE_DNS_API_TOKEN', options)) ||
    present(valueOf('cloudflare:apiToken', options));
  if (!options.skipPreflight && !token) {
    assertPreflight('Cloudflare', [
      {
        key: 'CLOUDFLARE_API_TOKEN',
        message: 'CLOUDFLARE_API_TOKEN, CLOUDFLARE_DNS_API_TOKEN, or cloudflare:apiToken is required.'
      }
    ]);
  }
}

export const checkDigitalOceanPreflight = preflightDigitalOcean;
export const checkOpenStackPreflight = preflightOpenStack;
export const checkCloudflarePreflight = preflightCloudflare;
