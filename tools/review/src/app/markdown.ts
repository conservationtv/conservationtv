// GitHub's alerts in Markdown: a blockquote that opens with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or
// `[!CAUTION]`. remark-gfm leaves them as blockquotes; this marks each with its kind and takes the marker out, so it
// is drawn as a callout (`.callout` in styles.css) rather than a quote with the marker in it.

/** As much of a Markdown syntax tree (mdast) as this reads and writes. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: NodeData;
}

/** What remark hands on to the HTML it becomes: the element it is, and its attributes. */
interface NodeData {
  hName?: string;
  hProperties?: Record<string, string | boolean>;
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i;

const alertTitles = new Map([
  ['note', 'Note'],
  ['tip', 'Tip'],
  ['important', 'Important'],
  ['warning', 'Warning'],
  ['caution', 'Caution']
]);

/** The text a blockquote opens with, where an alert's marker would be. */
function openingText(node: MarkdownNode): MarkdownNode | undefined {
  const [paragraph] = node.children ?? [];
  const [text] = paragraph?.type === 'paragraph' ? (paragraph.children ?? []) : [];
  return text?.type === 'text' ? text : undefined;
}

/** The blockquote as an alert, when its first text is a marker. */
function markAlert(node: MarkdownNode): void {
  const text = openingText(node);
  const match = (text?.value ?? '').match(ALERT);
  if (!text || !match?.[1]) return;
  const kind = match[1].toLowerCase();
  text.value = (text.value ?? '').slice(match[0].length);
  node.data = { hProperties: { className: `callout callout-${kind}`, 'data-title': alertTitles.get(kind) ?? kind } };
}

function visit(node: MarkdownNode): void {
  if (node.type === 'blockquote') markAlert(node);
  node.children?.forEach(visit);
}

/** The remark plugin: run after remark-gfm. */
export function remarkAlerts() {
  return (tree: MarkdownNode) => visit(tree);
}

// GitHub's folds in Markdown: `<details>` and `<summary>`, which are HTML. Raw HTML is shown as text here (anyone may
// comment on a public repository), so these two alone are read: each `<details>` block, its summary and everything up
// to its `</details>` becomes a details element of its own, with the Markdown inside it rendered as Markdown.

const OPENS = /^<details(\s+open)?\s*>/i;
const CLOSES = /<\/details>\s*$/i;
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/i;

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/** A details element, with its summary first. */
function detailsNode(summary: string, open: boolean, children: MarkdownNode[]): MarkdownNode {
  const summaryNode: MarkdownNode = {
    type: 'summary',
    data: { hName: 'summary' },
    children: [{ type: 'text', value: summary || 'Details' }]
  };
  return {
    type: 'details',
    data: { hName: 'details', hProperties: open ? { open: true } : {} },
    children: [summaryNode, ...children]
  };
}

/** A fold written on one line, `<details><summary>…</summary>…</details>`, whose inside is text. */
function inlineDetails(html: string, open: boolean): MarkdownNode {
  const summary = html.match(SUMMARY)?.[1] ?? '';
  const inside = textOf(html.replace(OPENS, '').replace(SUMMARY, '').replace(CLOSES, ''));
  const body: MarkdownNode[] = inside ? [{ type: 'paragraph', children: [{ type: 'text', value: inside }] }] : [];
  return detailsNode(textOf(summary), open, body);
}

/** Where a `<details>` block opened at `start` closes, counting folds within it: the last sibling when it doesn't. */
function closingIndex(nodes: readonly MarkdownNode[], start: number): number {
  let depth = 1;
  for (let index = start + 1; index < nodes.length; index++) {
    // Nested folds open and close in pairs; the one that brings the count to nothing closes this one.
    const html = htmlOf(nodes[index]);
    if (OPENS.test(html) && !CLOSES.test(html)) depth++;
    if (/^<\/details>/i.test(html)) depth--;
    if (depth === 0) return index;
  }
  return nodes.length;
}

/** An HTML node's markup, trimmed; empty for any other node. */
function htmlOf(node: MarkdownNode | undefined): string {
  return node?.type === 'html' ? (node.value ?? '').trim() : '';
}

/**
 * The fold opened at `index`: closed in the same node, or with its summary there or in the next node and closed
 * further on. Also where reading carries on after it.
 */
function foldAt(nodes: readonly MarkdownNode[], index: number, open: boolean): [MarkdownNode, number] {
  const html = htmlOf(nodes[index]);
  if (CLOSES.test(html)) return [inlineDetails(html, open), index];
  const end = closingIndex(nodes, index);
  let inside = nodes.slice(index + 1, end);
  let summary = html.match(SUMMARY)?.[1];
  if (summary === undefined && SUMMARY.test(htmlOf(inside[0]))) {
    summary = htmlOf(inside[0]).match(SUMMARY)?.[1];
    inside = inside.slice(1);
  }
  return [detailsNode(textOf(summary ?? ''), open, foldDetails(inside)), end];
}

/** A list of sibling nodes with each `<details>` block among them gathered into a details element. */
function foldDetails(nodes: readonly MarkdownNode[]): MarkdownNode[] {
  const folded: MarkdownNode[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!node) continue;
    const opening = htmlOf(node).match(OPENS);
    if (opening) {
      const [details, end] = foldAt(nodes, index, Boolean(opening[1]));
      folded.push(details);
      index = end;
      continue;
    }
    folded.push(node.children ? { ...node, children: foldDetails(node.children) } : node);
  }
  return folded;
}

/** The remark plugin: run after remark-gfm. */
export function remarkDetails() {
  return (tree: MarkdownNode) => {
    tree.children = foldDetails(tree.children ?? []);
  };
}
