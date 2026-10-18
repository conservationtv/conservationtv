import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | JsonObject;

interface JsonObject {
  [key: string]: Json;
}

/** Hashes a parsed spec. Keys are sorted first, so the same spec hashes the same whatever order it was written in. */
export function revisionOf<Spec>(spec: Spec): string {
  const canonical = JSON.stringify(spec, sortKeys);
  const hash = createHash('sha256');
  hash.update(canonical);
  return hash.digest('hex');
}

function sortKeys(_key: string, value: Json): Json {
  if (!(value instanceof Object) || Array.isArray(value)) return value;
  const entries = Object.entries(value);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}
