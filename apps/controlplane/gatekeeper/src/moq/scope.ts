import { type MoqPath, MoqPathSchema } from '../grants/identifiers.ts';

/** Why a session can't be granted anything at the path it dialed. */
export class ScopeError extends Error {}

/** Subtree patterns as tokens carry them: `**`, or a canonical path followed by `/**`. */
export function isSubtreePattern(pattern: string): boolean {
  return pattern === '**' || (pattern.endsWith('/**') && MoqPathSchema.safeParse(pattern.slice(0, -3)).success);
}

export interface SessionPermissions {
  publish: string[];
  subscribe: string[];
}

const segmentsOf = (pattern: string) => (pattern === '**' ? [] : pattern.slice(0, -3).split('/'));
const startsWith = (path: string[], prefix: string[]) => prefix.every((segment, index) => path[index] === segment);
const subtree = (segments: string[]) => (segments.length ? `${segments.join('/')}/**` : '**');

/**
 * Re-express one subtree pattern below `suffix`, the part of the dialed path past the token root: unchanged in reach
 * if the suffix is inside it, narrowed if the pattern lies deeper, dropped if the two diverge.
 */
function rebase(pattern: string, suffix: string[]): string[] {
  const segments = segmentsOf(pattern);
  if (startsWith(suffix, segments)) return ['**'];
  if (startsWith(segments, suffix)) return [subtree(segments.slice(suffix.length))];
  return [];
}

/** The dialed path's segments. A dialed path is never normalised: an ambiguous one has no grant. */
function dialedSegments(dialed: string): string[] {
  const path = dialed.replace(/^\/+|\/+$/g, '');
  if (path === '') return [];
  if (!MoqPathSchema.safeParse(path).success) throw new ScopeError('the dialed path is not canonical');
  return path.split('/');
}

/** How each pattern is re-expressed at the dialed path, or a refusal when the path is beside the root. */
function scoperFor(path: string[], root: string[]): (pattern: string) => string[] {
  if (startsWith(path, root)) {
    const suffix = path.slice(root.length);
    return pattern => rebase(pattern, suffix);
  }
  if (startsWith(root, path)) {
    const prefix = root.slice(path.length);
    return pattern => [subtree([...prefix, ...segmentsOf(pattern)])];
  }
  throw new ScopeError('the token root does not overlap the dialed path');
}

/**
 * The permissions a token grants a session that dialed `dialed`, relative to that path, exactly as `moq auth serve`
 * computes them: a path at or below the token root keeps what each pattern reaches beneath it, a path above the root
 * prefixes the patterns with the rest of the root, and a path beside the root is refused. So is one that ends up with
 * no permissions at all. The relay then scopes the session to the dialed path with these patterns.
 */
export function scopeToDialedPath(root: MoqPath, permissions: SessionPermissions, dialed: string): SessionPermissions {
  const scope = scoperFor(dialedSegments(dialed), root.split('/'));
  const scoped = { publish: permissions.publish.flatMap(scope), subscribe: permissions.subscribe.flatMap(scope) };
  if (scoped.publish.length === 0 && scoped.subscribe.length === 0) {
    throw new ScopeError('nothing is granted at the dialed path');
  }
  return scoped;
}
