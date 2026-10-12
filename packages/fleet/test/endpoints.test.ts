import { describe, expect, it } from 'vitest';
import type { ComposeApp, ServiceEndpointDefinition } from '../src/core/contracts';
import { endpointIngress, endpointUrl, requireEndpoint, resolveEndpoints } from '../src/core/compose/endpoints';

function app(endpoints: Record<string, ServiceEndpointDefinition>, services = ['relay']): ComposeApp {
  return { name: 'relay-app', services: Object.fromEntries(services.map(name => [name, {}])), endpoints };
}

describe('service endpoints', () => {
  it('records ownership and defaults, and derives public ingress', () => {
    const endpoints = resolveEndpoints(
      app({
        'relay.https': {
          service: 'relay',
          port: 443,
          transport: 'tcp',
          visibility: 'public',
          scheme: 'https',
          paths: { health: '/health' }
        },
        'relay.metrics': { service: 'relay', port: 9101, transport: 'tcp', visibility: 'private', scheme: 'http' },
        'relay.internal': { service: 'relay', port: 8443, transport: 'tcp', visibility: 'public', binding: 'compose' }
      })
    );
    expect(endpoints['relay.https']).toMatchObject({
      owner: 'relay-app',
      binding: 'host',
      targetPort: 443,
      sourceCidrs: ['0.0.0.0/0', '::/0']
    });
    expect(endpointIngress(endpoints)).toEqual([{ protocol: 'tcp', port: 443, sourceCidrs: ['0.0.0.0/0', '::/0'] }]);

    const https = requireEndpoint(endpoints, 'relay.https');
    expect(endpointUrl(https, 'node.example.test')).toBe('https://node.example.test');
    expect(endpointUrl(https, 'node.example.test', https.paths?.health)).toBe('https://node.example.test/health');
    expect(endpointUrl(endpoints['relay.metrics'], 'node.example.test', '/metrics')).toBe(
      'http://node.example.test:9101/metrics'
    );
    expect(() => requireEndpoint(endpoints, 'relay.missing')).toThrow(/was not declared/);
  });

  it('unions source CIDRs of public endpoints sharing a listener', () => {
    const endpoints = resolveEndpoints(
      app({
        'relay.connect': {
          service: 'relay',
          port: 443,
          transport: 'tcp',
          visibility: 'public',
          sourceCidrs: ['192.0.2.0/24']
        },
        'relay.admin': {
          service: 'relay',
          port: 443,
          transport: 'tcp',
          visibility: 'public',
          sourceCidrs: ['198.51.100.0/24']
        },
        'relay.quic': { service: 'relay', port: 443, transport: 'udp', visibility: 'public' }
      })
    );
    expect(endpointIngress(endpoints)).toEqual([
      { protocol: 'tcp', port: 443, sourceCidrs: ['192.0.2.0/24', '198.51.100.0/24'] },
      { protocol: 'udp', port: 443, sourceCidrs: ['0.0.0.0/0', '::/0'] }
    ]);
  });

  it('rejects invalid definitions', () => {
    const tcp = { port: 8080, transport: 'tcp', visibility: 'public' } as const;
    expect(() => resolveEndpoints(app({ 'Bad Id': { service: 'relay', ...tcp } }))).toThrow(/lowercase labels/);
    expect(() => resolveEndpoints(app({ 'a.http': { service: 'missing', ...tcp } }))).toThrow(/unknown service/);
    expect(() => resolveEndpoints(app({ 'a.http': { service: 'relay', ...tcp, port: 0 } }))).toThrow(/port/);
    expect(() => resolveEndpoints(app({ 'a.http': { service: 'relay', ...tcp, targetPort: 70000 } }))).toThrow(
      /targetPort/
    );
    expect(() => resolveEndpoints(app({ 'a.http': { service: 'relay', ...tcp, scheme: 'HTTP' } }))).toThrow(/scheme/);
    expect(() =>
      resolveEndpoints(app({ 'a.http': { service: 'relay', ...tcp, paths: { health: 'health' } } }))
    ).toThrow(/named path/);
    expect(() =>
      resolveEndpoints(
        app({ 'a.http': { service: 'relay', ...tcp, visibility: 'private', sourceCidrs: ['192.0.2.0/24'] } })
      )
    ).toThrow(/sourceCidrs/);
    expect(() => resolveEndpoints(app({ 'a.http': { service: 'relay', ...tcp, sourceCidrs: ['nope'] } }))).toThrow(
      /CIDR/
    );
  });

  it('rejects one host listener shared by different services', () => {
    expect(() =>
      resolveEndpoints(
        app(
          {
            'one.http': { service: 'one', port: 8080, transport: 'tcp', visibility: 'public' },
            'two.http': { service: 'two', port: 8080, transport: 'tcp', visibility: 'private' }
          },
          ['one', 'two']
        )
      )
    ).toThrow(/Host listener collision on tcp:8080/);
    expect(
      Object.keys(
        resolveEndpoints(
          app(
            {
              'one.http': { service: 'one', port: 8080, transport: 'tcp', visibility: 'public', binding: 'compose' },
              'two.http': { service: 'two', port: 8080, transport: 'tcp', visibility: 'private', binding: 'compose' }
            },
            ['one', 'two']
          )
        )
      )
    ).toEqual(['one.http', 'two.http']);
  });
});
