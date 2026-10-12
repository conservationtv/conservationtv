import { describe, expect, it } from 'vitest';
import { preflightCloudflare, preflightDigitalOcean, preflightOpenStack } from '../src/core/preflight';

const empty = { env: {} };

describe('preflight', () => {
  it('reports every missing credential without making network calls', () => {
    expect(() => preflightDigitalOcean(empty)).toThrow(/DIGITALOCEAN_TOKEN/);
    expect(() => preflightCloudflare(empty)).toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(() => preflightOpenStack(empty)).toThrow(
      /OS_AUTH_URL[\s\S]*OS_REGION_NAME[\s\S]*OS_APPLICATION_CREDENTIAL_ID/
    );
  });

  it('accepts credentials from config or env', () => {
    expect(() => preflightDigitalOcean({ env: {}, config: { 'digitalocean:token': 'x' } })).not.toThrow();
    expect(() => preflightCloudflare({ env: { CLOUDFLARE_DNS_API_TOKEN: 'x' } })).not.toThrow();
    expect(() =>
      preflightOpenStack({
        env: {
          OS_AUTH_URL: 'https://auth.example.test/v3',
          OS_REGION_NAME: 'GRA',
          OS_USERNAME: 'u',
          OS_PASSWORD: 'p',
          OS_PROJECT_NAME: 'proj'
        }
      })
    ).not.toThrow();
  });

  it('treats blank values as missing and rejects a non-URL auth endpoint', () => {
    expect(() => preflightDigitalOcean({ env: { DIGITALOCEAN_TOKEN: '  ' } })).toThrow(/DIGITALOCEAN_TOKEN/);
    expect(() => preflightOpenStack({ env: { OS_AUTH_URL: 'auth.example.test' } })).toThrow(/absolute HTTP/);
  });

  it('can be skipped', () => {
    expect(() => preflightDigitalOcean({ ...empty, skip: true })).not.toThrow();
    expect(() => preflightOpenStack({ ...empty, skip: true })).not.toThrow();
    expect(() => preflightCloudflare({ ...empty, skip: true })).not.toThrow();
  });
});
