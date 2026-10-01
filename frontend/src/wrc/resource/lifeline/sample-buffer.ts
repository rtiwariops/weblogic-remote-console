/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

/**
 * One point on a Lifeline. A null value is a gap (no data for that poll),
 * which is drawn as a break in the trace rather than a repeat of the last value.
 */
export interface Sample {
  ts: number;
  value: number | null;
}

export const DEFAULT_CAPACITY = 200;
export const MAX_CAPACITY = 720;

/**
 * Fixed-capacity ring buffer of samples. When full, the oldest sample is
 * overwritten, so memory use is bounded no matter how long the page is open.
 */
export class SampleBuffer {
  private readonly items: (Sample | undefined)[];
  private start = 0;
  private count = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    const cap = Math.floor(capacity);
    if (!(cap >= 1)) {
      throw new Error(`Invalid sample buffer capacity: ${capacity}`);
    }
    this.items = new Array(Math.min(cap, MAX_CAPACITY));
  }

  get capacity(): number {
    return this.items.length;
  }

  get size(): number {
    return this.count;
  }

  push(sample: Sample): void {
    const end = (this.start + this.count) % this.capacity;
    this.items[end] = sample;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  latest(): Sample | undefined {
    return this.count === 0
      ? undefined
      : this.items[(this.start + this.count - 1) % this.capacity];
  }

  /** Samples ordered oldest to newest. */
  toArray(): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.items[(this.start + i) % this.capacity] as Sample);
    }
    return out;
  }

  /** Values ordered oldest to newest. */
  values(): (number | null)[] {
    return this.toArray().map((s) => s.value);
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}
