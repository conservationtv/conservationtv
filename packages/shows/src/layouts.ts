// The broadcast's layouts (docs/shows.md): for each slot count a show can have, from none to six, where each position
// sits on a 6×6 grid of the canvas, a unit being a sixth of it each way (320×180 of 1920×1080). Position 1 is always
// the largest. The show composes its grid from this table, and the studio draws its layout picker from the same one,
// so the two cannot disagree.
//
//    1            2            3            4            5            6
//   ┌─────────┐  ┌────┬────┐  ┌────┬────┐  ┌────┬────┐  ┌──┬──────┐  ┌──┬──────┐
//   │         │  │    │    │  │    │ 2  │  │ 1  │ 2  │  │3 │  1   │  │2 │      │
//   │    1    │  │ 1  │ 2  │  │ 1  ├────┤  ├────┼────┤  ├──┤──────┤  ├──┤  1   │
//   │         │  │    │    │  │    │ 3  │  │ 3  │ 4  │  │4 │  2   │  │3 │      │
//   └─────────┘  └────┴────┘  └────┴────┘  └────┴────┘  ├──┤      │  ├──┼──┬───┤
//                                                       │5 │      │  │4 │5 │ 6 │
//                                                       └──┴──────┘  └──┴──┴───┘

/** How many units the grid has each way. */
export const GRID_UNITS = 6;

/** The most slots a layout has. */
export const MAX_SLOTS = 6;

/** One position's rectangle on the grid, in units from the top left: `[column, row, width, height]`. */
export type SlotRect = readonly [column: number, row: number, width: number, height: number];

/** Each layout's positions in order, by its slot count: `LAYOUTS[0]` has none, `LAYOUTS[6]` six. */
export const LAYOUTS: readonly (readonly SlotRect[])[] = [
  [],
  [[0, 0, 6, 6]],
  [
    [0, 0, 3, 6],
    [3, 0, 3, 6]
  ],
  [
    [0, 0, 3, 6],
    [3, 0, 3, 3],
    [3, 3, 3, 3]
  ],
  [
    [0, 0, 3, 3],
    [3, 0, 3, 3],
    [0, 3, 3, 3],
    [3, 3, 3, 3]
  ],
  [
    [2, 0, 4, 3],
    [2, 3, 4, 3],
    [0, 0, 2, 2],
    [0, 2, 2, 2],
    [0, 4, 2, 2]
  ],
  [
    [2, 0, 4, 4],
    [0, 0, 2, 2],
    [0, 2, 2, 2],
    [0, 4, 2, 2],
    [2, 4, 2, 2],
    [4, 4, 2, 2]
  ]
];

/** The layout with `slots` positions: none below one, six above six, and a fraction rounded down. */
export function layoutOf(slots: number): readonly SlotRect[] {
  const count = Math.min(Math.max(Math.floor(slots), 0), MAX_SLOTS);
  return LAYOUTS[count]!;
}
