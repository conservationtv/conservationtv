// A black outline around text, as the broadcast draws one around its labels and the clock: text has no stroke that every
// target renders, so a hard-edged shadow in each of eight directions draws one around every letter.

/** The eight directions an outline is drawn in, as unit offsets. */
const DIRECTIONS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
] as const;

/** A black outline `width` pixels thick, as a CSS `text-shadow`. */
export function outline(width: number): string {
  return DIRECTIONS.map(([x, y]) => `${String(x * width)}px ${String(y * width)}px 0 #000000`).join(', ');
}
