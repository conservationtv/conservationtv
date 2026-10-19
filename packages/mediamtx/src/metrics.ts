// MediaMTX's metrics page (`metricsAddress`, `/metrics`): Prometheus text, one sample per line, in sections under
// comment headers such as `# Paths` and `# Paths (deprecated)`. No TYPE or HELP lines: the deprecated sections are
// how it says which samples are kept only for compatibility.

export interface PrometheusLabels {
  [label: string]: string;
}

export interface PrometheusSample {
  name: string;
  labels: PrometheusLabels;
  value: number;
  /** The comment the sample is under, such as `Paths`, or `null` before the first one. */
  section: string | null;
  /** Whether the section is one MediaMTX marks `(deprecated)`. */
  deprecated: boolean;
}

const SAMPLE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/u;
const LABEL = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/gu;

function unescape(value: string): string {
  return value.replace(/\\(.)/gu, (_match, escaped: string) => (escaped === 'n' ? '\n' : escaped));
}

function labelsOf(text: string | undefined): PrometheusLabels {
  const labels: PrometheusLabels = {};
  if (text === undefined) return labels;
  for (const [, name, value] of text.matchAll(LABEL)) labels[name!] = unescape(value!);
  return labels;
}

/** The samples on a metrics page. Lines that aren't samples, and samples whose value isn't a number, are skipped. */
export function parseMetrics(text: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  let section: string | null = null;
  for (const line of text.split('\n')) {
    // A comment opens a section when it names one, as `# Paths` does and `# The remoteAddr label is deprecated.`
    // doesn't. Anything else is a sample, or skipped.
    if (line.startsWith('#')) {
      const comment = line.slice(1).trim();
      if (comment !== '' && !comment.startsWith('The ')) section = comment;
      continue;
    }
    const match = SAMPLE.exec(line);
    if (match === null) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({
      name: match[1]!,
      labels: labelsOf(match[2]),
      value,
      section,
      deprecated: section?.includes('(deprecated)') ?? false
    });
  }
  return samples;
}
