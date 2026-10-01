/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import { Sample } from "./sample-buffer";

// Geometry taken from the WebLogic Server 8.1 console Performance page:
// fixed-size black panels on a 10px grid, "now" at the right edge,
// scale maximum at top-left, 0 at bottom-left and the current value at the
// right edge.
export const GRAPH_WIDTH = 400;
export const SMALL_GRAPH_HEIGHT = 50;
export const LARGE_GRAPH_HEIGHT = 150;
// at the normal poll rate one poll is this many pixels apart
export const POINT_SPACING = 2;
export const GRID_SIZE = 10;

const LABEL_BASELINE = 10;
// the current value is printed this far above the latest point
const CURRENT_LABEL_OFFSET = 10;
// on the short graphs the current value is always printed at top-right
const FOLLOW_TRACE_MIN_HEIGHT = 60;

/**
 * line:  a connected trace (gaps break it)
 * spike: a baseline at 0 with a thin vertical line up to each non-zero value
 */
export type GraphMode = "line" | "spike";

type Props = {
  samples: Sample[];
  now: number;
  windowMs: number;
  current: number | null;
  max?: number;
  mode?: GraphMode;
  width?: number;
  height?: number;
  title: string;
};

type Geometry = {
  width: number;
  height: number;
  scaleMax: number;
  now: number;
  windowMs: number;
};

export const formatGraphValue = (v: number): string => String(Math.round(v));

/**
 * Horizontal position of a timestamp: "now" is the right-most column and
 * windowMs is the time span across the whole panel. Positions come from
 * time, not sample count, so an outage shows up as blank space that keeps
 * growing however few polls were made during it.
 */
export const xForTimestamp = (ts: number, now: number, windowMs: number, width: number): number => {
  const right = width - 1;
  if (!(windowMs > 0)) return -1; // no time window yet: nothing is visible
  const age = Math.max(0, now - ts);
  return Math.round(right - (age / windowMs) * right);
};

export const visibleSamples = (samples: Sample[], now: number, windowMs: number): Sample[] =>
  windowMs > 0 ? samples.filter((s) => now - s.ts <= windowMs) : [];

export const computeScaleMax = (values: (number | null)[], max?: number): number => {
  if (max !== undefined && Number.isFinite(max) && max > 0) return max;
  let m = 0;
  for (const v of values) if (v !== null && v > m) m = v;
  return m;
};

export const valueToY = (v: number, height: number, scaleMax: number): number => {
  if (scaleMax <= 0) return Math.floor(height / 2);
  const ratio = Math.min(1, Math.max(0, v / scaleMax));
  return Math.round((height - 1) * (1 - ratio));
};

// split into runs of consecutive non-null samples
const segmentsOf = (samples: Sample[], g: Geometry): [number, number, number][][] => {
  const segments: [number, number, number][][] = [];
  let segment: [number, number, number][] = [];
  for (const s of samples) {
    const x = xForTimestamp(s.ts, g.now, g.windowMs, g.width);
    if (s.value === null || x < 0) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    segment.push([x, valueToY(s.value, g.height, g.scaleMax), s.value]);
  }
  if (segment.length) segments.push(segment);
  return segments;
};

const polyline = (points: [number, number][]): string =>
  points.length === 1
    ? `M${points[0][0] + 0.5} ${points[0][1] + 0.5}h-1` // an isolated point is drawn as a dot
    : points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x + 0.5} ${y + 0.5}`).join("");

/** Connected trace; gaps (null) break the line. */
export const buildTracePath = (samples: Sample[], g: Geometry): string =>
  segmentsOf(samples, g)
    .map((seg) => polyline(seg.map(([x, y]) => [x, y])))
    .join("");

/**
 * Spike trace: the zero baseline (broken at gaps) plus a 1px vertical line
 * from the baseline to every non-zero value.
 */
export const buildSpikePath = (samples: Sample[], g: Geometry): string => {
  const base = valueToY(0, g.height, g.scaleMax);
  return segmentsOf(samples, g)
    .map((seg) => {
      const baseline = polyline(seg.map(([x]) => [x, base]));
      const spikes = seg
        .filter(([, , v]) => v !== 0)
        .map(([x, y]) => `M${x + 0.5} ${base + 0.5}V${y + 0.5}`)
        .join("");
      return baseline + spikes;
    })
    .join("");
};

/** Baseline y of the current-value text, kept inside the panel. */
export const currentLabelY = (
  current: number | null,
  height: number,
  scaleMax: number,
): number => {
  if (height < FOLLOW_TRACE_MIN_HEIGHT || current === null) return LABEL_BASELINE;
  const y = valueToY(current, height, scaleMax) - CURRENT_LABEL_OFFSET;
  return Math.min(height - 3, Math.max(LABEL_BASELINE, y));
};

const gridLines = (width: number, height: number): string => {
  const parts: string[] = [];
  for (let x = GRID_SIZE; x < width; x += GRID_SIZE) parts.push(`M${x + 0.5} 0V${height}`);
  for (let y = GRID_SIZE; y < height; y += GRID_SIZE) parts.push(`M0 ${y + 0.5}H${width}`);
  return parts.join("");
};

export const LifelineGraph = ({
  samples,
  now,
  windowMs,
  current,
  max,
  mode = "line",
  width = GRAPH_WIDTH,
  height = SMALL_GRAPH_HEIGHT,
  title,
}: Props) => {
  const shown = visibleSamples(samples, now, windowMs);
  const scaleMax = computeScaleMax(shown.map((s) => s.value), max);
  const geometry = { width, height, scaleMax, now, windowMs };
  const path = mode === "spike" ? buildSpikePath(shown, geometry) : buildTracePath(shown, geometry);
  const currentText = current === null ? "—" : formatGraphValue(current);

  return (
    <svg
      class="wrc-lifeline-graph"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${title} ${currentText}`}
    >
      <rect class="wrc-lifeline-graph-bg" x="0" y="0" width={width} height={height} />
      <path class="wrc-lifeline-graph-grid" d={gridLines(width, height)} />
      <path class="wrc-lifeline-graph-trace" d={path} />
      <text class="wrc-lifeline-graph-label" x="2" y={LABEL_BASELINE}>
        {formatGraphValue(scaleMax)}
      </text>
      <text class="wrc-lifeline-graph-label" x="2" y={height - 2}>
        0
      </text>
      <text
        class="wrc-lifeline-graph-label"
        x={width - 2}
        y={currentLabelY(current, height, scaleMax)}
        text-anchor="end"
      >
        {currentText}
      </text>
    </svg>
  );
};

export default LifelineGraph;
