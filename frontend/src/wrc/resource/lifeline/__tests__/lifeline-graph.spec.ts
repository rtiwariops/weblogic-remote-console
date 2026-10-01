/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import {
  buildSpikePath,
  buildTracePath,
  computeScaleMax,
  currentLabelY,
  valueToY,
  visibleSamples,
  xForTimestamp,
} from "../lifeline-graph";
import { Sample } from "../sample-buffer";

const NOW = 1_000_000;
const WINDOW = 1000; // ms across the panel
const WIDTH = 11; // right-most column is x=10, so 1px per 100ms

const geometry = (overrides = {}) => ({
  width: WIDTH,
  height: 11,
  scaleMax: 10,
  now: NOW,
  windowMs: WINDOW,
  ...overrides,
});

const at = (msAgo: number, value: number | null): Sample => ({ ts: NOW - msAgo, value });

describe("lifeline graph geometry", () => {
  it("scales to the given maximum, or to the largest value shown", () => {
    expect(computeScaleMax([1, 5, null, 3], 100)).toBe(100);
    expect(computeScaleMax([1, 5, null, 3])).toBe(5);
    expect(computeScaleMax([null, 0])).toBe(0);
  });

  it("maps 0 to the bottom row and the maximum to the top row", () => {
    expect(valueToY(0, 50, 10)).toBe(49);
    expect(valueToY(10, 50, 10)).toBe(0);
    expect(valueToY(20, 50, 10)).toBe(0);
  });

  it("draws a flat trace through the middle when there is no scale", () => {
    expect(valueToY(0, 50, 0)).toBe(25);
  });
});

describe("timestamp positioning", () => {
  it("puts now at the right edge and windowMs ago at the left edge", () => {
    expect(xForTimestamp(NOW, NOW, WINDOW, WIDTH)).toBe(10);
    expect(xForTimestamp(NOW - 500, NOW, WINDOW, WIDTH)).toBe(5);
    expect(xForTimestamp(NOW - 1000, NOW, WINDOW, WIDTH)).toBe(0);
  });

  it("keeps a sample from a slightly fast clock at the right edge", () => {
    expect(xForTimestamp(NOW + 50, NOW, WINDOW, WIDTH)).toBe(10);
  });

  it("matches the 2px-per-poll spacing at the normal poll rate", () => {
    // 200 polls of 5s across a 400px panel
    const window = 200 * 5000;
    expect(xForTimestamp(NOW, NOW, window, 400) - xForTimestamp(NOW - 5000, NOW, window, 400)).toBe(2);
  });

  it("shows nothing until there is a time window", () => {
    expect(xForTimestamp(NOW, NOW, 0, WIDTH)).toBe(-1);
    expect(visibleSamples([at(0, 1)], NOW, 0)).toEqual([]);
    expect(buildTracePath([at(0, 1), at(100, 1)], geometry({ windowMs: 0 }))).toBe("");
  });

  it("drops samples older than the window", () => {
    expect(visibleSamples([at(1500, 1), at(900, 2), at(0, 3)], NOW, WINDOW).map((s) => s.value)).toEqual([2, 3]);
  });

  it("leaves a blank area that grows with elapsed time after the last sample", () => {
    const samples = [at(400, 5), at(300, 5)];
    const early = buildTracePath(samples, geometry());
    const later = buildTracePath(samples, geometry({ now: NOW + 300 }));
    expect(early).toBe("M6.5 5.5L7.5 5.5");
    expect(later).toBe("M3.5 5.5L4.5 5.5");
  });
});

describe("line mode", () => {
  it("connects samples and breaks the line at gaps", () => {
    const d = buildTracePath([at(400, 0), at(300, 10), at(200, null), at(100, 10), at(0, 0)], geometry());
    expect(d).toBe("M6.5 10.5L7.5 0.5M9.5 0.5L10.5 10.5");
  });

  it("draws an isolated sample as a dot", () => {
    expect(buildTracePath([at(100, null), at(0, 5)], geometry())).toBe("M10.5 5.5h-1");
  });
});

describe("spike mode", () => {
  it("draws a baseline with a thin vertical line for each non-zero value", () => {
    const d = buildSpikePath([at(300, 0), at(200, 10), at(100, 0), at(0, 5)], geometry());
    expect(d).toBe(
      "M7.5 10.5L8.5 10.5L9.5 10.5L10.5 10.5" + // baseline at 0
        "M8.5 10.5V0.5" + // spike to 10
        "M10.5 10.5V5.5", // spike to 5
    );
  });

  it("breaks the baseline at gaps and draws no spike for them", () => {
    const d = buildSpikePath([at(300, 0), at(200, null), at(100, 4), at(0, 0)], geometry());
    expect(d).toBe("M7.5 10.5h-1M9.5 10.5L10.5 10.5M9.5 10.5V6.5");
  });
});

describe("current value label", () => {
  it("sits about 10px above the latest point on the tall graph", () => {
    // value 50 of 100 on a 150px graph is y=75 -> label baseline 65
    expect(currentLabelY(50, 150, 100)).toBe(65);
  });

  it("stays inside the panel near the top and the bottom", () => {
    expect(currentLabelY(100, 150, 100)).toBe(10);
    expect(currentLabelY(0, 150, 100)).toBe(139);
    expect(currentLabelY(0, 150, 100)).toBeLessThanOrEqual(147);
  });

  it("is printed at top-right on the short graphs and when there is no value", () => {
    expect(currentLabelY(0, 50, 10)).toBe(10);
    expect(currentLabelY(null, 150, 100)).toBe(10);
  });
});
