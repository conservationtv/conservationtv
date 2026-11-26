import { describe, expect, it } from 'vitest';
import {
  chooseDelivery,
  chooseIngest,
  reachable,
  type DeliveryCandidate,
  type DeliveryReader
} from '../../src/gateways/delivery.ts';

/** A healthy exposure on an internet gateway read by MoQ and WebRTC. */
function candidate(exposureId: string, overrides: Partial<DeliveryCandidate> = {}): DeliveryCandidate {
  return {
    exposureId,
    gatewayId: `${exposureId}-gateway`,
    networkId: null,
    egress: ['moq', 'webrtc'],
    failing: false,
    ...overrides
  };
}

/** A reader on the internet, with no input gateway, playing MoQ before WebRTC. */
function reader(overrides: Partial<DeliveryReader> = {}): DeliveryReader {
  return { networkId: null, inputGatewayId: null, protocols: ['moq', 'webrtc'], ...overrides };
}

const chosenId = (candidates: DeliveryCandidate[], who: DeliveryReader) =>
  chooseDelivery(candidates, who)?.candidate.exposureId;

describe('reaching a gateway', () => {
  it('reaches the internet from anywhere, and a network only from on it', () => {
    expect(reachable({ gatewayId: 'g', networkId: null }, { networkId: null, inputGatewayId: null })).toBe(true);
    expect(reachable({ gatewayId: 'g', networkId: 'site' }, { networkId: null, inputGatewayId: null })).toBe(false);
    expect(reachable({ gatewayId: 'g', networkId: 'site' }, { networkId: 'site', inputGatewayId: null })).toBe(true);
    expect(reachable({ gatewayId: 'g', networkId: 'site' }, { networkId: 'other', inputGatewayId: null })).toBe(false);
  });

  it('reaches only its input gateway when an output names one', () => {
    expect(reachable({ gatewayId: 'g', networkId: null }, { networkId: null, inputGatewayId: 'h' })).toBe(false);
    expect(reachable({ gatewayId: 'h', networkId: null }, { networkId: null, inputGatewayId: 'h' })).toBe(true);
  });
});

describe('choosing a delivery', () => {
  it('prefers the caller’s own network, then conservation.tv, then any other internet gateway', () => {
    const other = candidate('other');
    const ctv = candidate('ctv', { gatewayId: 'conservationtv' });
    const local = candidate('local', { networkId: 'site' });
    expect(chosenId([other, ctv, local], reader({ networkId: 'site' }))).toBe('local');
    expect(chosenId([other, ctv, local], reader())).toBe('ctv');
    expect(chosenId([other, local], reader())).toBe('other');
  });

  it('leaves only the input gateway, even when another is nearer', () => {
    const ctv = candidate('ctv', { gatewayId: 'conservationtv' });
    const pinned = candidate('pinned', { gatewayId: 'pinned-gateway' });
    expect(chosenId([ctv, pinned], reader({ inputGatewayId: 'pinned-gateway' }))).toBe('pinned');
    expect(chosenId([ctv], reader({ inputGatewayId: 'pinned-gateway' }))).toBeUndefined();
  });

  it('sorts failing deliveries after healthy ones, and those not live after both', () => {
    const ctvFailing = candidate('ctv', { gatewayId: 'conservationtv', failing: true });
    const other = candidate('other');
    expect(chosenId([ctvFailing, other], reader())).toBe('other');

    const notLive = candidate('not-live', { gatewayId: 'conservationtv', live: false });
    const failingLive = candidate('failing-live', { failing: true, live: true });
    expect(chosenId([notLive, failingLive], reader())).toBe('failing-live');
    // A gateway that cannot say is not taken for one that is not live.
    const unknown = candidate('unknown', { live: null });
    expect(chosenId([notLive, unknown], reader())).toBe('unknown');
  });

  it('reads by the first protocol the gateway speaks, and prefers the reader’s order between equals', () => {
    const webrtc = candidate('webrtc', { egress: ['webrtc'] });
    const moq = candidate('moq', { egress: ['moq'] });
    expect(chooseDelivery([webrtc, moq], reader())).toMatchObject({
      candidate: { exposureId: 'moq' },
      protocol: 'moq'
    });
    expect(chooseDelivery([webrtc], reader())?.protocol).toBe('webrtc');
  });

  it('chooses the oldest of otherwise equal deliveries, and none when nothing is readable', () => {
    expect(chosenId([candidate('first'), candidate('second')], reader())).toBe('first');
    expect(chosenId([candidate('hls', { egress: ['hls'] })], reader())).toBeUndefined();
  });
});

describe('choosing an ingest', () => {
  const ingest = (gatewayId: string, networkId: string | null, protocols = ['moq', 'webrtc']) => ({
    gatewayId,
    networkId,
    ingest: protocols
  });

  it('prefers the publisher’s own network, then conservation.tv, then any other internet gateway', () => {
    const candidates = [ingest('other', null), ingest('conservationtv', null), ingest('site-gateway', 'site')];
    const publisher = { networkId: 'site', protocols: ['moq', 'webrtc'] };
    expect(chooseIngest(candidates, publisher)?.candidate.gatewayId).toBe('site-gateway');
    expect(chooseIngest(candidates, { ...publisher, networkId: null })?.candidate.gatewayId).toBe('conservationtv');
  });

  it('publishes by the publisher’s first protocol the gateway takes, and to nothing it cannot reach', () => {
    const chosen = chooseIngest([ingest('conservationtv', null, ['webrtc'])], {
      networkId: null,
      protocols: ['moq', 'webrtc']
    });
    expect(chosen?.protocol).toBe('webrtc');
    expect(chooseIngest([ingest('site-gateway', 'site')], { networkId: null, protocols: ['moq'] })).toBeUndefined();
  });
});
