import type { Gateway } from '@conservationtv/studio-sdk';
import { z } from 'zod';

import type { GatewayInput } from '@/forms/schemas';

// What the studio knows about gateways, in words: their kinds, the protocols a MediaMTX gateway serves, and the URL
// overrides its settings keep (apps/studio/api/src/gateways/).

/** A gateway as the organisation's list carries it: a built-in one, or one of its own. */
export type ListedGateway = Gateway['gateways'][number];

/** A protocol a MediaMTX gateway serves, and what it is called. */
interface GatewayProtocol {
  protocol: 'webrtc' | 'rtsp' | 'rtsps' | 'rtmp' | 'rtmps' | 'hls';
  label: string;
}

/** The protocols a MediaMTX gateway is published to and read by. */
export const GATEWAY_PROTOCOLS = [
  { protocol: 'webrtc', label: 'WebRTC' },
  { protocol: 'rtsp', label: 'RTSP' },
  { protocol: 'rtsps', label: 'RTSPS' },
  { protocol: 'rtmp', label: 'RTMP' },
  { protocol: 'rtmps', label: 'RTMPS' },
  { protocol: 'hls', label: 'HLS' }
] as const satisfies readonly GatewayProtocol[];

/** What a protocol is called, or the protocol itself for one the studio doesn't know. */
export function protocolLabelOf(protocol: string): string {
  return GATEWAY_PROTOCOLS.find(candidate => candidate.protocol === protocol)?.label ?? protocol;
}

/** What a kind of gateway is called. */
export function gatewayKindLabelOf(kind: string): string {
  if (kind === 'mediamtx') return 'MediaMTX';
  if (kind === 'moq-relay') return 'MoQ relay';
  return kind;
}

/** A MediaMTX gateway's settings, as far as the studio reads them: its URL overrides by protocol. */
const MediamtxSettingsSchema = z
  .object({
    urls: z
      .object({
        webrtc: z.string().optional(),
        rtsp: z.string().optional(),
        rtsps: z.string().optional(),
        rtmp: z.string().optional(),
        rtmps: z.string().optional(),
        hls: z.string().optional()
      })
      .default({})
  })
  .catch({ urls: {} });
export type MediamtxSettings = z.output<typeof MediamtxSettingsSchema>;

/** A URL override: which protocol, and the URL used in place of what the gateway's agent registers. */
export interface GatewayOverride {
  protocol: string;
  label: string;
  url: string;
}

/** The gateway's URL overrides, in protocol order: none for a gateway that uses what its agent registers. */
export function gatewayOverridesOf(gateway: ListedGateway): GatewayOverride[] {
  const { urls } = MediamtxSettingsSchema.parse(gateway.settings);
  return GATEWAY_PROTOCOLS.flatMap(({ protocol, label }) => {
    const url = urls[protocol];
    return url === undefined ? [] : [{ protocol, label, url }];
  });
}

/** A gateway as its form starts from it: every protocol's override, empty where it has none. */
export function gatewayInputOf(gateway: ListedGateway): GatewayInput {
  const { urls } = MediamtxSettingsSchema.parse(gateway.settings);
  return {
    name: gateway.name,
    networkId: gateway.networkId ?? '',
    urls: {
      webrtc: urls.webrtc ?? '',
      rtsp: urls.rtsp ?? '',
      rtsps: urls.rtsps ?? '',
      rtmp: urls.rtmp ?? '',
      rtmps: urls.rtmps ?? '',
      hls: urls.hls ?? ''
    }
  };
}
