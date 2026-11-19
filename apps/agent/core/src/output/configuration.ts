import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { type DeviceConfiguration, leased, withToken } from '../studio.ts';
import type { ChannelsSpec, ReportedChannel } from './channels/runtime.ts';
import type { PreviewPublish } from './obs/program.ts';
import type { ObsSpec } from './obs/runtime.ts';
import type { ShowSpec } from './show/runtime.ts';

// The output's keys, from the configuration's `obs` and `show` sections, the output the agent sends out
// (system/configuration.ts):
//
//   obs       the `obs` section as it is, but for each preview, with where to publish it from
//             `organisations.outputs.previews.connect`, kept until shortly before it expires;
//   channels  its forwards whose channels have stats, each channel once, which the runtime reads with
//             `organisations.channels.stats.get` as it reports, so no credential is kept for them;
//   show      the `show` section as it is: the show driving OBS's scenes, absent when nothing in the studio does.

const logger = getLogger(['agent', 'studio']);

/** The configuration's `obs` and `show` sections. */
type ObsSection = NonNullable<DeviceConfiguration['obs']>;
type ShowSection = DeviceConfiguration['show'];

/** The output's keys' specs: `channels` absent with no channel to read, `show` absent with no show to follow. */
export interface OutputSpecs {
  obs: ObsSpec;
  channels: ChannelsSpec | undefined;
  show: ShowSpec | undefined;
}

/** The connection details `organisations.outputs.previews.connect` returns, whichever protocol. */
type PreviewConnection = Exclude<
  Awaited<ReturnType<Client['organisations']['outputs']['previews']['connect']['v1']>>,
  Error
>;

/** The credentials kept between asks, each until shortly before it expires: to publish each preview, by its ID. */
export interface OutputLeases {
  previews: Map<string, PreviewConnection>;
}

/** The `obs` and `channels` specs of the `obs` section, and the `show` spec of the `show` section. */
export async function outputSpecs(
  obs: ObsSection,
  show: ShowSection,
  studio: Client,
  leases: OutputLeases
): Promise<OutputSpecs> {
  return { obs: await obsSpec(obs, studio, leases), channels: channelsSpec(obs), show };
}

/** The `channels` key's spec: each channel the `obs` section forwards to that has stats, once; absent for none. */
function channelsSpec(obs: ObsSection): ChannelsSpec | undefined {
  const channels = new Map<string, ReportedChannel>();
  for (const { organisationId, channelId, stats } of obs.forwards) {
    if (stats === true) channels.set(channelId, { organisationId, channelId });
  }
  if (channels.size === 0) return undefined;
  return { channels: [...channels.values()] };
}

/** The `obs` key's spec from the `obs` section: as it is, but for each preview, with where to publish it. */
async function obsSpec(obs: ObsSection, studio: Client, leases: OutputLeases): Promise<ObsSpec> {
  const previews: ObsSpec['previews'] = [];
  for (const { previewId, connect: ask } of obs.previews) {
    // One whose credentials cannot be had is left out, and tried again next time.
    try {
      const publish = await previewTarget(studio, leases.previews, ask);
      previews.push({ previewId, publish });
    } catch (error) {
      logger.error('Preview {previewId} is unavailable: {error}', { previewId, error });
    }
  }
  const { output, encoding, forwards, recording, program } = obs;
  return { output, encoding, forwards, previews, recording, program };
}

/** The `previews.connect` ask the configuration gives for where to publish a preview. */
type PreviewConnect = NonNullable<ObsSection['previews']>[number]['connect'];

/**
 * Where to publish the preview: by MoQ, the relay URL to dial at its path, carrying its token as `?jwt=`, and the
 * broadcast under it; by RTMP(S), the URL to push to, carrying its token as `?jwt=`. From the lease `previews.connect`
 * gives (studio.ts); throws if it refuses, or offers a protocol the agent can't push.
 */
async function previewTarget(
  studio: Client,
  connections: OutputLeases['previews'],
  ask: PreviewConnect
): Promise<PreviewPublish> {
  const renew = () => studio.organisations.outputs.previews.connect.v1(ask);
  const connection = await leased(connections, ask.previewId, renew);
  if ('relay' in connection) {
    const url = new URL(connection.path, connection.relay);
    return { protocol: 'moq', connect: withToken(url, connection.token), broadcast: connection.broadcast };
  }
  const { protocol } = connection;
  if (protocol !== 'rtmp' && protocol !== 'rtmps') throw new Error(`Preview ${ask.previewId} is not pushed by RTMP`);
  const url = new URL(connection.url);
  return { protocol, url: withToken(url, connection.token) };
}
