import type { ReportData } from './report.ts';

// The report as one HTML file beside its images: the data inline, rendered by a little script, so it opens from disk
// with nothing to serve it. Filters narrow it to issues or changes, a scenario, a theme; a shot opens larger, with its
// baseline and diff and everything recorded about it.

/** The report's data as JSON that can sit inside a script element: nothing in it can close the element. */
function escapeJson(data: ReportData): string {
  return JSON.stringify(data).replace(/</gu, '\\u003c');
}

const STYLE = `
:root {
  --bg: #f6f5f2; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6a66; --line: #e3e1dc;
  --issue: #c0362c; --issue-bg: #fbe9e7; --change: #a15c00; --change-bg: #fdf0dc; --new: #2357b5; --new-bg: #e6eefb;
  --ok: #2d7a46; --ok-bg: #e5f3ea; --shadow: 0 1px 2px rgb(0 0 0 / 6%), 0 2px 8px rgb(0 0 0 / 4%);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --panel: #201f1e; --text: #ecebe8; --muted: #9c9a95; --line: #34332f;
    --issue: #ff8a7d; --issue-bg: #3a1f1c; --change: #f2b55c; --change-bg: #3a2c16; --new: #8fb2ff; --new-bg: #1b2740;
    --ok: #7fd19b; --ok-bg: #18301f; --shadow: none; color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 28px 32px 8px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 650; }
h2 { font-size: 17px; margin: 0; font-weight: 650; }
.meta { color: var(--muted); }
.stats { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; box-shadow: var(--shadow); }
.stat b { font-size: 18px; display: block; font-variant-numeric: tabular-nums; }
.toolbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 10px 32px; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.toolbar select, .toolbar input, .seg button { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; }
.seg { display: inline-flex; }
.seg button { border-radius: 0; margin-left: -1px; cursor: pointer; }
.seg button:first-child { border-radius: 8px 0 0 8px; margin-left: 0; }
.seg button:last-child { border-radius: 0 8px 8px 0; }
.seg button[aria-pressed=true] { background: var(--text); color: var(--bg); border-color: var(--text); }
main { padding: 8px 32px 64px; }
section.scenario { margin-top: 28px; }
.scenario-head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.scenario-head code { color: var(--muted); }
.desc { color: var(--muted); margin: 4px 0 8px; max-width: 900px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.chip { font-size: 12px; border-radius: 999px; padding: 2px 9px; background: var(--panel); border: 1px solid var(--line); }
.chip.issue { background: var(--issue-bg); color: var(--issue); border-color: transparent; }
.chip.change { background: var(--change-bg); color: var(--change); border-color: transparent; }
.chip.new { background: var(--new-bg); color: var(--new); border-color: transparent; }
.chip.ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.incidents { margin: 4px 0 10px; padding-left: 18px; color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; margin-top: 10px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; cursor: pointer; box-shadow: var(--shadow); display: flex; flex-direction: column; }
.card:hover { outline: 2px solid color-mix(in srgb, var(--text) 25%, transparent); }
.thumb { aspect-ratio: 8 / 5; overflow: hidden; background: var(--line); border-bottom: 1px solid var(--line); position: relative; }
.thumb img { width: 100%; height: 100%; display: block; object-fit: cover; object-position: top; }
.thumb .pair { display: grid; grid-template-columns: 1fr 1fr 1fr; height: 100%; }
.thumb .pair img { border-right: 1px solid var(--line); }
.grid.pending { min-height: var(--pending-height, 300px); }
.more { height: 1px; }
.card-body { padding: 9px 12px 11px; display: flex; flex-direction: column; gap: 5px; }
.card-title { font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
.card-title span { color: var(--muted); font-weight: 400; }
.empty { color: var(--muted); padding: 40px 0; text-align: center; }
dialog { width: min(1500px, 96vw); max-height: 94vh; border: 1px solid var(--line); border-radius: 14px; padding: 0; background: var(--panel); color: var(--text); }
dialog::backdrop { background: rgb(0 0 0 / 55%); }
.dlg-head { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); z-index: 1; flex-wrap: wrap; }
.dlg-body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 0; }
.dlg-images { padding: 14px; overflow: auto; }
.dlg-images img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; }
.dlg-images .sbs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dlg-images .sbs figure { margin: 0; }
.dlg-images figcaption { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.dlg-side { border-left: 1px solid var(--line); padding: 14px 16px; overflow: auto; font-size: 13px; }
.dlg-side h3 { font-size: 13px; margin: 14px 0 4px; }
.dlg-side h3:first-child { margin-top: 0; }
.dlg-side pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); border-radius: 6px; padding: 6px 8px; margin: 0 0 4px; font-size: 12px; }
.dlg-side a { color: inherit; }
button.close { font: inherit; background: none; border: 1px solid var(--line); color: inherit; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
@media (max-width: 700px) {
  header, main, .toolbar { padding-left: 16px; padding-right: 16px; }
  .dlg-body { grid-template-columns: 1fr; }
  .dlg-side { border-left: none; border-top: 1px solid var(--line); }
}
`;

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const state = { view: data.baseline ? 'changed' : 'all', theme: 'all', scenario: 'all', search: '', sort: data.baseline ? 'changed' : 'scenario' };
const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};
const percent = ratio => ratio === 0 ? '0%' : ratio < 0.0001 ? '<0.01%' : (ratio * 100).toFixed(ratio < 0.01 ? 2 : 1) + '%';
const changed = shot => shot.difference && shot.difference.pixels > 0;
const isNew = shot => data.baseline && !shot.difference;

function chipsOf(shot) {
  const chips = shot.issues.map(issue => el('span', { className: 'chip issue', textContent: issue }));
  if (changed(shot)) chips.push(el('span', { className: 'chip change', textContent: 'Changed ' + percent(shot.difference.ratio) + (shot.difference.moved ? ', moved ' + percent(shot.difference.moved) : '') + (shot.difference.sizeChanged ? ', resized' : '') }));
  if (isNew(shot)) chips.push(el('span', { className: 'chip new', textContent: 'New' }));
  if (shot.redirectedTo) chips.push(el('span', { className: 'chip', textContent: '→ ' + shot.redirectedTo }));
  for (const note of shot.expected ?? []) chips.push(el('span', { className: 'chip', textContent: note }));
  if (!chips.length) chips.push(el('span', { className: 'chip ok', textContent: data.baseline ? 'Unchanged, no issues' : 'No issues' }));
  return chips;
}

function visible(shot) {
  if (state.view === 'issues' && !shot.issues.length) return false;
  if (state.view === 'changed' && !changed(shot) && !isNew(shot)) return false;
  if (state.theme !== 'all' && shot.theme !== state.theme) return false;
  if (state.scenario !== 'all' && shot.scenario !== state.scenario) return false;
  if (state.search && !(shot.pageTitle + ' ' + shot.page).toLowerCase().includes(state.search.toLowerCase())) return false;
  return true;
}

/** A card's image: the small first-screen thumbnail, fetched only as it nears the viewport. */
const thumbnail = (src, alt) => el('img', { src, alt, loading: 'lazy', decoding: 'async', width: 480, height: 300 });

function card(shot) {
  const thumb = el('div', { className: 'thumb' });
  if (changed(shot)) {
    thumb.append(el('div', { className: 'pair' },
      thumbnail(shot.difference.baselineThumb, 'Before'),
      thumbnail(shot.thumb, 'After'),
      thumbnail(shot.difference.diffThumb, 'Diff')));
  } else {
    thumb.append(thumbnail(shot.thumb, shot.pageTitle));
  }
  const node = el('div', { className: 'card', tabIndex: 0 },
    thumb,
    el('div', { className: 'card-body' },
      el('div', { className: 'card-title' }, shot.pageTitle, el('span', { textContent: shot.theme + ' · ' + shot.viewport })),
      el('div', { className: 'chips' }, chipsOf(shot))));
  node.addEventListener('click', () => open(shot));
  node.addEventListener('keydown', event => { if (event.key === 'Enter') open(shot); });
  return node;
}

// Only what is near the screen is built: each scenario's cards when its section comes within a screen or two of the
// viewport, and the ranked list a page at a time as it is scrolled. A report of hundreds of shots then costs a few
// dozen cards and thumbnails to open.
const CHUNK = 60;
let observer;

/** Calls \`fill\` once, when \`node\` comes near the viewport. */
function whenNear(node, fill) {
  observer.observe(node);
  node.fill = fill;
}

function ranked(shots) {
  const weight = shot => shot.difference?.ratio ?? (isNew(shot) ? 1 : 0);
  return [...shots].sort((a, b) => (b.issues.length > 0) - (a.issues.length > 0) || weight(b) - weight(a));
}

function rankedCard(shot) {
  const node = card(shot);
  node.querySelector('.card-title').firstChild.textContent = scenarioTitle(shot.scenario) + ' — ' + shot.pageTitle;
  return node;
}

/** The ranked list, a chunk at a time: a marker after the last card loads the next chunk when it nears the screen. */
function renderRanked(main, shots) {
  const grid = el('div', { className: 'grid' });
  main.append(el('section', { className: 'scenario' }, grid));
  let shown = 0;
  const more = () => {
    grid.append(...shots.slice(shown, shown + CHUNK).map(rankedCard));
    shown += CHUNK;
    if (shown >= shots.length) return;
    const marker = el('div', { className: 'more' });
    grid.after(marker);
    whenNear(marker, () => { marker.remove(); more(); });
  };
  more();
}

function scenarioSection(scenario, mine) {
  const counts = Object.entries(scenario.counts).map(([name, count]) => el('span', { className: 'chip', textContent: count + ' ' + name }));
  const faults = scenario.faults.map(fault => el('span', { className: 'chip issue', textContent: 'Fault: ' + fault }));
  // Held open at about its eventual height, so the page's length and the scrollbar don't jump as sections fill.
  const grid = el('div', { className: 'grid pending' });
  grid.style.setProperty('--pending-height', Math.ceil(mine.length / 4) * 300 + 'px');
  whenNear(grid, () => { grid.classList.remove('pending'); grid.append(...mine.map(card)); });
  return el('section', { className: 'scenario' },
    el('div', { className: 'scenario-head' }, el('h2', { textContent: scenario.title }), el('code', { textContent: scenario.id })),
    el('p', { className: 'desc', textContent: scenario.description }),
    el('div', { className: 'chips' }, counts, faults),
    scenario.incidents.length ? el('ul', { className: 'incidents' }, scenario.incidents.map(incident => el('li', { textContent: incident }))) : null,
    grid);
}

function render() {
  observer?.disconnect();
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target.fill();
    }
  }, { rootMargin: '1500px 0px' });
  const main = $('main');
  main.replaceChildren();
  const shots = data.shots.filter(visible);
  if (!shots.length) { main.append(el('p', { className: 'empty', textContent: 'Nothing matches these filters.' })); return; }
  if (state.sort === 'changed') return renderRanked(main, ranked(shots));
  for (const scenario of data.scenarios) {
    const mine = shots.filter(shot => shot.scenario === scenario.id);
    if (mine.length) main.append(scenarioSection(scenario, mine));
  }
}

const scenarioTitle = id => data.scenarios.find(scenario => scenario.id === id)?.title ?? id;

function detailList(title, items) {
  if (!items.length) return [];
  return [el('h3', { textContent: title + ' (' + items.length + ')' }), items.map(item => el('pre', { textContent: item }))];
}

function open(shot) {
  const dialog = $('dialog');
  const modes = changed(shot) ? ['Side by side', 'Now', 'Before', 'Diff'] : ['Now'];
  let mode = modes[0];
  const images = el('div', { className: 'dlg-images' });
  const paint = () => {
    images.replaceChildren();
    if (mode === 'Side by side') {
      images.append(el('div', { className: 'sbs' },
        el('figure', {}, el('figcaption', { textContent: 'Before (' + data.baseline.label + ')' }), el('img', { src: shot.difference.baselineFile })),
        el('figure', {}, el('figcaption', { textContent: 'Now' }), el('img', { src: shot.file }))));
    } else {
      images.append(el('img', { src: mode === 'Before' ? shot.difference.baselineFile : mode === 'Diff' ? shot.difference.diffFile : shot.file }));
    }
    for (const button of seg.children) button.setAttribute('aria-pressed', String(button.textContent === mode));
  };
  const seg = el('div', { className: 'seg' }, modes.map(name => {
    const button = el('button', { textContent: name, type: 'button' });
    button.addEventListener('click', () => { mode = name; paint(); });
    return button;
  }));
  const ledger = shot.ledger.map(entry => entry.kind + ': ' + entry.method + ' ' + entry.path + (entry.operationId ? ' (' + entry.operationId + ')' : '') + '\\n' + entry.detail);
  const side = el('div', { className: 'dlg-side' },
    el('h3', { textContent: 'Page' }), el('pre', { textContent: shot.path + (shot.redirectedTo ? '\\n→ ' + shot.redirectedTo : '') }),
    el('div', { className: 'chips' }, chipsOf(shot)),
    el('h3', { textContent: 'Capture' }), el('pre', { textContent: (shot.settled ? 'Settled' : 'Never settled') + ' in ' + (shot.durationMs / 1000).toFixed(1) + 's' }),
    detailList('Gone from the page', shot.difference?.text?.removed ?? []),
    detailList('New on the page', shot.difference?.text?.added ?? []),
    detailList('Uncaught errors', shot.pageErrors),
    detailList('Console errors', shot.consoleErrors),
    detailList('Failed API calls', shot.apiFailures),
    detailList('Mock API notes', ledger),
    el('h3', {}, el('a', { href: shot.file, target: '_blank', textContent: 'Open the full image' })));
  const close = el('button', { className: 'close', type: 'button', textContent: 'Close' });
  close.addEventListener('click', () => dialog.close());
  dialog.replaceChildren(
    el('div', { className: 'dlg-head' }, el('strong', { textContent: scenarioTitle(shot.scenario) + ' — ' + shot.pageTitle + ' · ' + shot.theme + ' · ' + shot.viewport }), seg, close),
    el('div', { className: 'dlg-body' }, images, side));
  paint();
  dialog.showModal();
}

function toolbar() {
  const bar = $('.toolbar');
  const segment = (key, options) => {
    const node = el('div', { className: 'seg' });
    for (const [value, label] of options) {
      const button = el('button', { type: 'button', textContent: label });
      button.setAttribute('aria-pressed', String(state[key] === value));
      button.addEventListener('click', () => {
        state[key] = value;
        for (const other of node.children) other.setAttribute('aria-pressed', String(other === button));
        render();
      });
      node.append(button);
    }
    return node;
  };
  const views = [['all', 'All'], ['issues', 'Issues']];
  if (data.baseline) views.push(['changed', 'Changed']);
  const scenario = el('select', {}, el('option', { value: 'all', textContent: 'All scenarios' }), data.scenarios.map(s => el('option', { value: s.id, textContent: s.title })));
  scenario.addEventListener('change', () => { state.scenario = scenario.value; render(); });
  const search = el('input', { type: 'search', placeholder: 'Page…' });
  search.addEventListener('input', () => { state.search = search.value; render(); });
  bar.append(segment('view', views), segment('theme', [['all', 'Both themes'], ['light', 'Light'], ['dark', 'Dark']]),
    segment('sort', [['scenario', 'By scenario'], ['changed', data.baseline ? 'Most changed' : 'Issues first']]), scenario, search);
}

/** A link to one shot, \`#shot=<key>\` (as a pull request's summary writes them), opens it. */
function openLinked() {
  const key = decodeURIComponent(location.hash.replace(/^#shot=/, ''));
  const shot = location.hash.startsWith('#shot=') && data.shots.find(candidate => candidate.key === key);
  if (shot) open(shot);
}

toolbar();
render();
openLinked();
window.addEventListener('hashchange', openLinked);
`;

/** The report page: its summary figures, a toolbar and the shots, which the inline script renders from the data. */
export function renderReport(data: ReportData): string {
  const issues = data.shots.filter(shot => shot.issues.length).length;
  const changed = data.shots.filter(shot => shot.difference && shot.difference.pixels > 0).length;
  const added = data.baseline ? data.shots.filter(shot => !shot.difference).length : 0;
  const stat = (value: number | string, label: string) => `<div class="stat"><b>${value}</b>${label}</div>`;
  const commit = `${data.git.branch} @ ${data.git.commit}${data.git.dirty ? ' (uncommitted changes)' : ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scenario report</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Scenario report: ${data.label}</h1>
  <div class="meta">${commit} · ${new Date(data.createdAt).toLocaleString('en-GB')}${data.baseline ? ` · compared with ${data.baseline.label} @ ${data.baseline.commit}` : ''}</div>
  <div class="stats">
    ${stat(data.scenarios.length, 'scenarios')}
    ${stat(data.shots.length, 'screenshots')}
    ${stat(issues, 'with issues')}
    ${data.baseline ? stat(changed, 'changed') + stat(added, 'new') + stat(data.removed.length, 'gone') : ''}
  </div>
</header>
<div class="toolbar"></div>
<main></main>
<dialog></dialog>
<script id="data" type="application/json">${escapeJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
