import { z } from 'zod';

// Formats the control plane accepts are deliberately narrow. Ambiguous forms are rejected rather than normalised, so a
// value that passes validation has exactly one interpretation when a relay scopes a session by it.

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,64}$/;
const MAX_PATH_LENGTH = 256;
const MAX_PATH_DEPTH = 16;
const MAX_NAMESPACE_LENGTH = 32;

const canonicalPath = (maxLength: number, maxDepth: number) =>
  z
    .string()
    .max(maxLength)
    .refine(path => {
      const segments = path.split('/');
      return segments.length <= maxDepth && segments.every(segment => SEGMENT.test(segment));
    }, 'Expected a canonical slash-separated path');

/** `app-a/t_92/room_71`: slash-separated, no empty, `.` or `..` segments, no leading or trailing slash, no wildcards. */
export const MoqPathSchema = canonicalPath(MAX_PATH_LENGTH, MAX_PATH_DEPTH);
export type MoqPath = z.output<typeof MoqPathSchema>;

/**
 * A consumer's namespace, such as `staging`, `local` or `preview`: one lowercase path segment. Gatekeeper places each
 * consumer's MoQ roots beneath it, so consumers sharing an environment's relays can use the same paths.
 */
export const ConsumerNamespaceSchema = z
  .string()
  .regex(new RegExp(`^[a-z0-9-]{1,${MAX_NAMESPACE_LENGTH}}$`), 'Expected lowercase letters, digits and hyphens');
export type ConsumerNamespace = z.output<typeof ConsumerNamespaceSchema>;

/** The root a consumer asks for, a canonical path with room left for the namespace segment gatekeeper prefixes. */
export const MoqRootSchema = canonicalPath(MAX_PATH_LENGTH - MAX_NAMESPACE_LENGTH - 1, MAX_PATH_DEPTH - 1);

/** A publish or subscribe entry relative to the grant's root. The empty string authorises the whole root. */
export const MoqRelativePathSchema = z.union([z.literal(''), MoqPathSchema]);
export type MoqRelativePath = z.output<typeof MoqRelativePathSchema>;

/** An iroh EndpointId: the endpoint's Ed25519 public key in lowercase hex. */
export const EndpointIdSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex Ed25519 public key');
export type EndpointId = z.output<typeof EndpointIdSchema>;

/** An opaque, application-defined subject such as `app-a:user:opaque-8f83d2`. Printable ASCII without spaces. */
export const GrantSubjectSchema = z.string().regex(/^[\x21-\x7e]{1,256}$/, 'Expected printable ASCII');
export type GrantSubject = z.output<typeof GrantSubjectSchema>;
