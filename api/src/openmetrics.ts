export type MetricType = "gauge" | "counter";

export interface MetricSample {
  labels?: Record<string, string>;
  value: number;
}

export interface MetricSeries {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

const COUNTER_SUFFIX = "_total";

// Escape order matters: backslash first, so the backslashes introduced by
// the newline/quote escapes below aren't themselves re-escaped.
function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string> | undefined): string {
  const entries = labels ? Object.entries(labels) : [];
  if (entries.length === 0) return "";
  const parts = entries.map(
    ([name, value]) => `${name}="${escapeLabelValue(value)}"`,
  );
  return `{${parts.join(",")}}`;
}

// Per OpenMetrics, a counter's MetricFamily name (used on TYPE/HELP) is the
// value name minus its "_total" suffix; the suffix belongs only to the
// sample line. Keeping MetricSeries.name equal to the sample name lets
// callers pass the exact public metric name and still render correct
// metadata lines.
function familyName(series: MetricSeries): string {
  if (series.type === "counter" && series.name.endsWith(COUNTER_SUFFIX)) {
    return series.name.slice(0, -COUNTER_SUFFIX.length);
  }
  return series.name;
}

export function renderMetrics(series: MetricSeries[]): string {
  const lines: string[] = [];

  for (const family of series) {
    if (family.samples.length === 0) continue;

    const name = familyName(family);
    lines.push(`# TYPE ${name} ${family.type}`);
    lines.push(`# HELP ${name} ${family.help}`);
    for (const sample of family.samples) {
      lines.push(
        `${family.name}${formatLabels(sample.labels)} ${sample.value}`,
      );
    }
  }

  lines.push("# EOF");
  return `${lines.join("\n")}\n`;
}
