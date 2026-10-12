import { describe, expect, it } from 'vitest';
import { mergeServiceEndpoints, requireServiceEndpoint, serviceEndpointUrl } from '../src/core/endpoints';
import { ingressFromServiceEndpoints } from '../src/core/machine';

describe('service endpoint composition', () => {
  it('records ownership and derives public firewall intent', () => {
    const endpoints = mergeServiceEndpoints([
      {
        owner: 'relay-app',
        services: { relay: {} },
        endpoints: {
          'relay.https': {
            service: 'relay',
            port: 443,
            transport: 'tcp',
            visibility: 'public',
            scheme: 'https',
            paths: { health: '/health' }
          },
          'relay.metrics': {
            service: 'relay',
            port: 9101,
            transport: 'tcp',
            visibility: 'private',
            scheme: 'http'
          }
        }
      }
    ]);
    expect(endpoints['relay.https']).toMatchObject({
      owner: 'relay-app',
      binding: 'host',
      targetPort: 443,
      sourceCidrs: ['0.0.0.0/0', '::/0']
    });
    expect(ingressFromServiceEndpoints(endpoints)).toEqual([
      { protocol: 'tcp', port: 443, sourceCidrs: ['0.0.0.0/0', '::/0'] }
    ]);
    const https = requireServiceEndpoint(endpoints, 'relay.https');
    expect(serviceEndpointUrl(https, 'node.example.test')).toBe('https://node.example.test');
    expect(serviceEndpointUrl(https, 'node.example.test', https.paths?.health)).toBe(
      'https://node.example.test/health'
    );
  });

  it('allows one service to describe multiple routes on its listener', () => {
    const endpoints = mergeServiceEndpoints([
      {
        owner: 'relay-app',
        services: { relay: {} },
        endpoints: {
          'relay.connect': { service: 'relay', port: 443, transport: 'tcp', visibility: 'public', scheme: 'https' },
          'relay.health': {
            service: 'relay',
            port: 443,
            transport: 'tcp',
            visibility: 'public',
            scheme: 'https',
            paths: { health: '/health' }
          }
        }
      }
    ]);
    expect(Object.keys(endpoints)).toEqual(['relay.connect', 'relay.health']);
    expect(ingressFromServiceEndpoints(endpoints)).toHaveLength(1);
  });

  it('rejects endpoint id, service, and listener ownership collisions', () => {
    expect(() =>
      mergeServiceEndpoints([
        {
          owner: 'one',
          services: { one: {} },
          endpoints: { 'shared.http': { service: 'one', port: 8080, transport: 'tcp', visibility: 'public' } }
        },
        {
          owner: 'two',
          services: { two: {} },
          endpoints: { 'shared.http': { service: 'two', port: 9090, transport: 'tcp', visibility: 'public' } }
        }
      ])
    ).toThrow(/endpoint id collision/);
    expect(() =>
      mergeServiceEndpoints([
        {
          owner: 'bad',
          services: { app: {} },
          endpoints: { 'bad.http': { service: 'missing', port: 8080, transport: 'tcp', visibility: 'public' } }
        }
      ])
    ).toThrow(/unknown service/);
    expect(() =>
      mergeServiceEndpoints([
        {
          owner: 'one',
          services: { one: {} },
          endpoints: { 'one.http': { service: 'one', port: 8080, transport: 'tcp', visibility: 'public' } }
        },
        {
          owner: 'two',
          services: { two: {} },
          endpoints: { 'two.http': { service: 'two', port: 8080, transport: 'tcp', visibility: 'private' } }
        }
      ])
    ).toThrow(/Host listener collision/);
  });

  it('supports endpoint-specific public CIDR restrictions', () => {
    const endpoints = mergeServiceEndpoints([
      {
        owner: 'admin',
        services: { admin: {} },
        endpoints: {
          'admin.https': {
            service: 'admin',
            port: 8443,
            transport: 'tcp',
            visibility: 'public',
            sourceCidrs: ['192.0.2.0/24']
          }
        }
      }
    ]);
    expect(ingressFromServiceEndpoints(endpoints)[0].sourceCidrs).toEqual(['192.0.2.0/24']);
  });
});
