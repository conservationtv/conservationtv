import { z } from 'zod';
import type { Check } from './checks.ts';
import { ArtifactSchema, ManifestSchema } from './manifest.ts';
import { type Unpack, unpackers } from './unpack.ts';

export interface BinaryOptions<N extends string> {
  /** The name its manifests carry, and its folder in a store. */
  name: N;
  /**
   * Unpackers by format, added to (or replacing) the defaults: `file`, `gzip`, `bzip2`, `tar` and `zip`. A manifest
   * can only name a format the binary has an unpacker for.
   */
  unpackers?: Record<string, Unpack>;
  /** Run against each unpacked download, in order, before it's installed. Any that throws turns it away. */
  checks?: Check[];
}

/** Narrows the manifest to one binary: its name, and only the formats it can unpack. */
function schemaFor<const N extends string>(name: N, formats: string[]) {
  const FormatSchema = z.string().refine(value => formats.includes(value), `One of ${formats.join(', ')}`);
  return ManifestSchema.extend({
    name: z.literal(name),
    artifacts: z.record(z.string(), ArtifactSchema.extend({ format: FormatSchema }))
  });
}
export type BinarySchema<N extends string> = ReturnType<typeof schemaFor<N>>;

/**
 * How one binary is packaged and checked, which is code; its manifests, saying which version and where to download
 * it, are data. A store installs any binary from its definition and a manifest.
 */
export interface Binary<N extends string = string> {
  name: N;
  unpackers: Record<string, Unpack>;
  checks: Check[];
  /** The manifest schema for this binary, to put in a spec: a manifest it can't install fails when the spec is parsed. */
  schema: BinarySchema<N>;
}

export function defineBinary<const N extends string>(options: BinaryOptions<N>): Binary<N> {
  const all = { ...unpackers, ...options.unpackers };
  return {
    name: options.name,
    unpackers: all,
    checks: options.checks ?? [],
    schema: schemaFor(options.name, Object.keys(all))
  };
}
