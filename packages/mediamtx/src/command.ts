/**
 * A `$` MediaMTX would take as the start of a variable: one before a name, a brace or a shell's special parameter. It
 * expands them (Go's `os.Expand`) in every word after splitting, quoted or not, and has no escape for one.
 */
const EXPANDED = /\$[\w{*#$@!?-]/u;

/** One word of a command, single-quoted: all of it literal but a single quote, which is closed over and escaped. */
function quoted(word: string, index: number): string {
  // Unnamed in the error: a word may carry a token.
  if (EXPANDED.test(word)) throw new Error(`MediaMTX would expand a $ in word ${String(index)} of its command`);
  return `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * A command for MediaMTX to run (`runOnInit`, `runOnDemand`, `runOnRead` and the rest), the program and its arguments
 * as `words`, each reaching the program exactly as given: spaces, quotes and backslashes included. MediaMTX splits a
 * command as a POSIX shell would (go-shellquote), on Windows too, where an unquoted `C:\…` path would lose its
 * backslashes; so every word is single-quoted. Opening with a quote, it is also never the `cmd …` MediaMTX passes
 * through whole on Windows. A word with a `$` MediaMTX would expand is refused, as nothing can keep it literal.
 */
export function mediamtxCommand(words: readonly string[]): string {
  return words.map(quoted).join(' ');
}
