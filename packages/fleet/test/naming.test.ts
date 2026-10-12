import { describe, expect, it } from 'vitest';
import { resourceName, sanitizeName, truncateWithHash } from '../src/core/naming';

describe('naming', () => {
  it('sanitizes and joins names', () => {
    expect(sanitizeName(' My_App / One ')).toBe('my-app-one');
    expect(resourceName('Fleet', 'na east')).toBe('fleet-na-east');
  });
  it('truncates with a stable suffix', () => {
    const value = truncateWithHash('a-very-long-resource-name', 16);
    expect(value.length).toBeLessThanOrEqual(16);
    expect(value).toBe(truncateWithHash('a-very-long-resource-name', 16));
  });
});
