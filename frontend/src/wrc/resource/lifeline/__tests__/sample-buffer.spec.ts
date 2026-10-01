/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import { MAX_CAPACITY, SampleBuffer } from "../sample-buffer";

describe("SampleBuffer", () => {
  it("returns samples oldest to newest", () => {
    const b = new SampleBuffer(5);
    [1, 2, 3].forEach((v, i) => b.push({ ts: i, value: v }));
    expect(b.values()).toEqual([1, 2, 3]);
    expect(b.latest()).toEqual({ ts: 2, value: 3 });
    expect(b.size).toBe(3);
  });

  it("never grows past its capacity and drops the oldest samples", () => {
    const b = new SampleBuffer(3);
    for (let i = 0; i < 10; i++) b.push({ ts: i, value: i });
    expect(b.size).toBe(3);
    expect(b.values()).toEqual([7, 8, 9]);
    expect(b.toArray().map((s) => s.ts)).toEqual([7, 8, 9]);
  });

  it("keeps null gaps", () => {
    const b = new SampleBuffer(4);
    b.push({ ts: 1, value: 5 });
    b.push({ ts: 2, value: null });
    b.push({ ts: 3, value: 6 });
    expect(b.values()).toEqual([5, null, 6]);
  });

  it("caps the capacity at the hard maximum", () => {
    expect(new SampleBuffer(MAX_CAPACITY * 10).capacity).toBe(MAX_CAPACITY);
  });

  it("rejects an unusable capacity", () => {
    expect(() => new SampleBuffer(0)).toThrow();
    expect(() => new SampleBuffer(NaN)).toThrow();
  });

  it("clears", () => {
    const b = new SampleBuffer(3);
    b.push({ ts: 1, value: 1 });
    b.clear();
    expect(b.size).toBe(0);
    expect(b.latest()).toBeUndefined();
    expect(b.values()).toEqual([]);
  });
});
