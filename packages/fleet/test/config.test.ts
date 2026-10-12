import { describe, expect, it } from 'vitest';
import {
  imageMutableReferenceWarning,
  readCidrs,
  readHttpsUrl,
  readSshAccessConfig,
  readSubdomain
} from '../src/core/config';

describe('config validators', () => {
  it('validates domains and HTTPS URLs', () => {
    expect(readSubdomain('na-east')).toBe('na-east');
    expect(readHttpsUrl('https://example.test/')).toBe('https://example.test');
    expect(() => readSubdomain('Bad.Name')).toThrow();
    expect(() => readHttpsUrl('http://example.test')).toThrow();
  });
  it('validates and deduplicates CIDRs and SSH ports', () => {
    expect(readCidrs(['10.0.0.0/8', '10.0.0.0/8'])).toEqual(['10.0.0.0/8']);
    expect(readSshAccessConfig({ port: 2222, allowedCidrs: ['::/0'] }).allowedCidrs).toEqual(['::/0']);
    expect(() => readSshAccessConfig({ port: 22 })).toThrow();
  });
  it('warns for untagged images', () => {
    expect(imageMutableReferenceWarning('docker.io/example/app')).toContain('mutable');
    expect(imageMutableReferenceWarning('example/app:1.2')).toBeUndefined();
    expect(imageMutableReferenceWarning('example/app@sha256:abc')).toBeUndefined();
  });
});
