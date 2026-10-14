import { z } from 'zod';

const JsonSchema = z.json();
export type Json = z.output<typeof JsonSchema>;

export class DuplicateMemberError extends Error {}

/** Index of the quote closing the string literal that opens at `start`. The text is already known to be valid JSON. */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
  return index;
}

/** Record a member name in the innermost object, returning it if that object already had it. */
function recordName(names: Set<string> | undefined, literal: string): string | undefined {
  if (!names) return undefined;
  const name = z.string().parse(JSON.parse(literal));
  if (names.has(name)) return name;
  names.add(name);
  return undefined;
}

/** Track structural characters: one name set per open object, a placeholder per array. Returns `expectingName`. */
function structural(char: string | undefined, scopes: Array<Set<string> | undefined>, expectingName: boolean): boolean {
  switch (char) {
    case '{':
      scopes.push(new Set());
      return true;
    case '[':
      scopes.push(undefined);
      return false;
    case '}':
    case ']':
      scopes.pop();
      return false;
    case ',':
      return scopes.at(-1) !== undefined;
    default:
      return expectingName;
  }
}

/**
 * Find an object that repeats a member name. `JSON.parse` silently keeps the last value, so two parsers can disagree
 * about the same document; security-relevant input must have exactly one reading. Walks the already-validated text and
 * treats a string as a member name only directly after `{` or a `,` inside an object.
 */
function duplicateMember(text: string): string | undefined {
  const scopes: Array<Set<string> | undefined> = [];
  let expectingName = false;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') {
      expectingName = structural(text[index], scopes, expectingName);
      continue;
    }
    const end = endOfString(text, index);
    const duplicate = expectingName ? recordName(scopes.at(-1), text.slice(index, end + 1)) : undefined;
    if (duplicate !== undefined) return duplicate;
    expectingName = false;
    index = end;
  }
  return undefined;
}

/** Parse JSON, rejecting duplicate member names anywhere in the document. Throws SyntaxError or DuplicateMemberError. */
export function parseStrictJson(text: string): Json {
  const value = JsonSchema.parse(JSON.parse(text));
  const duplicate = duplicateMember(text);
  if (duplicate !== undefined) throw new DuplicateMemberError(`Duplicate member: ${duplicate}`);
  return value;
}
