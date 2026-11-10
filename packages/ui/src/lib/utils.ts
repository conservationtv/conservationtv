import { createCn } from "cn/config"

// The design's own type scale (`--text-custom-*`, src/styles/figma-tokens.css). Without it, the merge takes
// `text-custom-13` for a colour and drops it whenever a text colour follows.
const customTextSizes = ["8", "10", "11", "12", "13", "15", "17", "21"].map(
  (size) => `custom-${size}`
)

/** Joins class names, a later Tailwind utility replacing an earlier one it conflicts with. */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: customTextSizes }] } },
})
