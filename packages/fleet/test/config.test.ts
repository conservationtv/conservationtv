import { describe, expect, it } from 'vitest';
import { assertDnsLabel, mutableImageWarning, readCidrs, readHttpsUrl, readSshAccess } from '../src/core/validate';

describe('validators', () => {
  it('validates DNS labels and HTTPS URLs', () => {
    expect(assertDnsLabel('na-east', 'label')).toBe('na-east');
    expect(readHttpsUrl('https://example.test/', 'url')).toBe('https://example.test');
    expect(() => assertDnsLabel('Bad.Name', 'label')).toThrow();
    expect(() => readHttpsUrl('http://example.test', 'url')).toThrow();
  });
  it('validates and deduplicates CIDRs and SSH ports', () => {
    expect(readCidrs(['10.0.0.0/8', '10.0.0.0/8'], 'cidrs')).toEqual(['10.0.0.0/8']);
    expect(readSshAccess({ port: 2222, allowedCidrs: ['::/0'] }).allowedCidrs).toEqual(['::/0']);
    expect(() => readSshAccess({ port: 22, allowedCidrs: [] })).toThrow();
  });
  it('warns for untagged images', () => {
    expect(mutableImageWarning('docker.io/example/app', 'image')).toContain('mutable');
    expect(mutableImageWarning('example/app:1.2', 'image')).toBeUndefined();
    expect(mutableImageWarning('example/app@sha256:abc', 'image')).toBeUndefined();
  });
});
