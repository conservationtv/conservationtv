import { describe, expect, it } from 'vitest';
import { collectPreflightIssues, preflightDigitalOcean, preflightOpenStack } from '../src/core/preflight';

describe('preflight', () => {
  it('aggregates missing credentials and supports skip', () => {
    expect(collectPreflightIssues(['A', 'B'], { env: {} })).toHaveLength(2);
    expect(collectPreflightIssues(['A', 'B'], { env: {}, skipPreflight: true })).toEqual([]);
  });
  it('checks provider credentials without making network calls', () => {
    expect(() => preflightDigitalOcean({ env: {} })).toThrow(/DIGITALOCEAN_TOKEN/);
    expect(() => preflightOpenStack({ env: {} })).toThrow(/OS_AUTH_URL/);
  });
});
