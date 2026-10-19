import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MediamtxConfigBuilder, pipeline, toYaml } from '@conservationtv/mediamtx';

// The config MediaMTX runs with, assembled by steps. For now it is fixed: every path accepted, and metrics on
// loopback. A step per concern, so later ones (cameras, recording, auth) are added to the pipeline beside them.

export interface ObservabilityParams {
  /** Where MediaMTX serves its metrics. */
  metricsAddress: string;
}

/** Structured logs, and Prometheus metrics. The default users let localhost read them without credentials. */
export const observability = new MediamtxConfigBuilder<ObservabilityParams>(({ metricsAddress }, config) => {
  config.logStructured = true;
  config.metrics = true;
  config.metricsAddress = metricsAddress;
});

/** Any stream may be published to, and read from, any path. */
export const anyPath = new MediamtxConfigBuilder<unknown>((_params, config) => {
  config.paths.all_others = {};
});

export const mediamtxConfig = pipeline(observability, anyPath);
export type MediamtxConfigParams = ObservabilityParams;

/** The config as mediamtx.yml. Throws if a step or the schema found an error. */
export async function renderConfig(params: MediamtxConfigParams): Promise<string> {
  const { config, diagnostics } = await mediamtxConfig.render(params);
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  if (errors.length > 0) throw new Error(`MediaMTX config: ${errors.map(error => error.message).join('; ')}`);
  return toYaml(config);
}

/** Renders the config into `directory` as mediamtx.yml, and returns its path. */
export async function writeConfig(directory: string, params: MediamtxConfigParams): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'mediamtx.yml');
  await writeFile(path, await renderConfig(params));
  return path;
}
