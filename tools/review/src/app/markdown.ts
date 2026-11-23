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

/** What remark hands on to the HTML it becomes: here, the attributes of the element. */
interface NodeData {
  hProperties?: Record<string, string>;
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
