import { posix } from 'node:path';
import { z } from 'zod';

/** A name or version safe to use as a single path segment, and never one of the store's own dot-files. */
const SegmentSchema = z
  .string()
  .regex(/^[A-Za-z0-9][\w.+-]*$/, 'A letter or digit, then letters, digits and . _ + - only');
export type Segment = z.output<typeof SegmentSchema>;

/** A path inside an archive, relative and staying inside it. */
const InnerPathSchema = z
  .string()
  .min(1)
  .refine(path => !posix.isAbsolute(path) && !path.split(/[\\/]/).includes('..'), 'A relative path inside the archive');
export type InnerPath = z.output<typeof InnerPathSchema>;

/** One platform's download: where it is, and the checksum it must match before anything unpacks or runs it. */
export const ArtifactSchema = z.object({
  url: z.url(),
  /** The download's checksum, as `sha256:<hex>` or `sha512:<hex>`. */
  checksum: z.string().regex(/^sha(256|512):[0-9a-f]+$/),
  /**
   * How the download is packed: always said, never guessed from the URL. The defaults are `file` (the binary itself),
   * `gzip` or `bzip2` (the binary, compressed), `tar` (any compression) and `zip`; a binary can add its own.
   */
  format: z.string().min(1),
  /** The executable's path inside the archive. The manifest's name (with `.exe` on Windows) at the top level if not given. */
  path: InnerPathSchema.optional()
});
export type Artifact = z.output<typeof ArtifactSchema>;

/** A version of a binary, with a download for each platform it runs on. */
export const ManifestSchema = z.object({
  name: SegmentSchema,
  version: SegmentSchema,
  /** Keyed by `${process.platform}-${process.arch}`, such as `darwin-arm64`, `linux-x64` or `win32-x64`. */
  artifacts: z.record(z.string(), ArtifactSchema)
});
export type Manifest = z.output<typeof ManifestSchema>;

/** This machine's key into a manifest's artifacts. */
export function platform(): string {
  return `${process.platform}-${process.arch}`;
}

/** This platform's artifact, with its path filled in. */
export function artifactFor(manifest: Manifest): Required<Artifact> {
  const key = platform();
  const artifact = manifest.artifacts[key];
  if (artifact === undefined) throw new Error(`No ${manifest.name} ${manifest.version} download for ${key}`);
  const executable = process.platform === 'win32' ? `${manifest.name}.exe` : manifest.name;
  return {
    ...artifact,
    path: artifact.path ?? executable
  };
}
