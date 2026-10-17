import { z } from 'zod';

// Formats the control plane accepts are deliberately narrow. Ambiguous forms are rejected rather than normalised, so a
// value that passes validation has exactly one interpretation when a relay scopes a session by it.

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,64}$/;
const MAX_PATH_LENGTH = 256;
const MAX_PATH_DEPTH = 16;

/** `app-a/t_92/room_71`: slash-separated, no empty, `.` or `..` segments, no leading or trailing slash, no wildcards. */
export const MoqPathSchema = z
  .string()
  .max(MAX_PATH_LENGTH)
  .refine(path => {
    const segments = path.split('/');
    return segments.length <= MAX_PATH_DEPTH && segments.every(segment => SEGMENT.test(segment));
  }, 'Expected a canonical slash-separated path');
export type MoqPath = z.output<typeof MoqPathSchema>;

/** A publish or subscribe entry relative to the grant's root. The empty string authorises the whole root. */
export const MoqRelativePathSchema = z.union([z.literal(''), MoqPathSchema]);
export type MoqRelativePath = z.output<typeof MoqRelativePathSchema>;

/** An iroh EndpointId: the endpoint's Ed25519 public key in lowercase hex. */
export const EndpointIdSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex Ed25519 public key');
export type EndpointId = z.output<typeof EndpointIdSchema>;

/** An opaque, application-defined subject such as `app-a:user:opaque-8f83d2`. Printable ASCII without spaces. */
export const GrantSubjectSchema = z.string().regex(/^[\x21-\x7e]{1,256}$/, 'Expected printable ASCII');
export type GrantSubject = z.output<typeof GrantSubjectSchema>;
