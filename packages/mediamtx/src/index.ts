import { stringify } from 'yaml';
import { MediamtxConfigSchema } from './generated/zod.gen.js';
import type { MediamtxConfig } from './generated/types.gen.js';

export * from './generated/types.gen.js';
export * from './generated/zod.gen.js';
export * from './builder.js';

/** Checks a config against the pinned MediaMTX release's schema, and returns it parsed. */
export function defineConfig(config: MediamtxConfig): MediamtxConfig {
  return MediamtxConfigSchema.parse(config);
}

/**
 * Checks a config and writes it as mediamtx.yml. MediaMTX reads YAML 1.1, where unquoted `no` and `off` are booleans,
 * so it is written as 1.1: settings such as `rtspEncryption: "no"` stay strings.
 */
export function toYaml(config: MediamtxConfig): string {
  return stringify(defineConfig(config), { version: '1.1' });
}
