/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import { DEFAULT_CAPACITY, Sample, SampleBuffer } from "./sample-buffer";

export type LifelineStatus = "LIVE" | "PAUSED" | "STALE" | "DISCONNECTED";

/** Raw attribute values from one poll, keyed by property name. */
export type RawSnapshot = Record<string, unknown>;

/**
 * A graphed series.
 *  - gauge: the value read from the snapshot is plotted as is
 *  - delta: the value is a cumulative counter; the change since the
 *           previous poll is plotted (a decrease, e.g. a server restart,
 *           becomes a gap)
 */
export interface SeriesDef {
  id: string;
  kind: "gauge" | "delta";
  read: (raw: RawSnapshot) => number | null | undefined;
}

/**
 * Identifies where samples come from. Samples are never shared across keys:
 * switching provider (domain) or server starts a fresh history.
 */
export interface SeriesKey {
  provider: string;
  beanPath: string;
}

type VisibilitySource = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

export interface SamplerOptions {
  key: SeriesKey;
  series: SeriesDef[];
  fetchSnapshot: () => Promise<RawSnapshot>;
  intervalMs?: number;
  capacity?: number;
  onChange?: () => void;
  now?: () => number;
  visibility?: VisibilitySource | null;
}

export const DEFAULT_INTERVAL_MS = 5000;
export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 60000;

// consecutive failures before STALE becomes DISCONNECTED
const DISCONNECT_AFTER_FAILURES = 2;
const MAX_BACKOFF_MS = 60000;
const MIN_REQUEST_TIMEOUT_MS = 10000;

export const clampInterval = (ms: number): number =>
  Number.isFinite(ms)
    ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)))
    : DEFAULT_INTERVAL_MS;

const toNumber = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const isAuthFailure = (err: unknown): boolean => {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 401 || status === 403;
};

/**
 * Polls one snapshot per interval and appends a sample for every series.
 *
 * Polls are chained (the next one is scheduled only after the previous one
 * settles), so requests never overlap. Responses that arrive after a reset,
 * key change, timeout or dispose are discarded by sequence number.
 */
export class LifelineSampler {
  private key: SeriesKey;
  private readonly series: SeriesDef[];
  private readonly fetchSnapshot: () => Promise<RawSnapshot>;
  private readonly onChange?: () => void;
  private readonly now: () => number;
  private readonly visibility: VisibilitySource | null;
  private readonly buffers = new Map<string, SampleBuffer>();
  private readonly previousCounters = new Map<string, number | null>();

  private intervalMs: number;
  private seq = 0;
  private failures = 0;
  private lastTs = -Infinity;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private paused = false;
  private latestSnapshot: RawSnapshot | null = null;

  status: LifelineStatus = "STALE";
  /** True once this key has produced at least one sample. */
  hasHadData = false;

  constructor(options: SamplerOptions) {
    this.key = { ...options.key };
    this.series = options.series;
    this.fetchSnapshot = options.fetchSnapshot;
    this.onChange = options.onChange;
    this.now = options.now || Date.now;
    this.visibility =
      options.visibility !== undefined
        ? options.visibility
        : typeof document !== "undefined" ? document : null;
    this.intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
    for (const s of this.series) {
      this.buffers.set(s.id, new SampleBuffer(options.capacity ?? DEFAULT_CAPACITY));
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.visibility?.addEventListener("visibilitychange", this.onVisibilityChange);
    if (this.visibility?.hidden) {
      this.pause();
    } else {
      this.poll();
    }
  }

  dispose(): void {
    this.running = false;
    this.seq++;
    this.clearTimers();
    this.visibility?.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.seq++;
    this.clearTimers();
    this.setStatus("PAUSED");
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    // whatever happened while paused is unknown -- don't bridge it
    this.appendGap();
    this.poll();
  }

  /** Switch to a different provider/server; history is discarded. */
  setKey(key: SeriesKey): void {
    if (key.provider === this.key.provider && key.beanPath === this.key.beanPath) return;
    this.key = { ...key };
    this.reset();
    if (this.running && !this.paused) this.poll();
  }

  getKey(): SeriesKey {
    return { ...this.key };
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }

  setIntervalMs(ms: number): void {
    const next = clampInterval(ms);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    // reschedule a waiting poll with the new interval; an in-flight poll
    // will pick it up when it settles
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      this.schedule(this.intervalMs);
    }
  }

  /** Values ordered oldest to newest. */
  values(seriesId: string): (number | null)[] {
    return this.buffers.get(seriesId)?.values() || [];
  }

  /** Timestamped samples ordered oldest to newest. */
  samples(seriesId: string): Sample[] {
    return this.buffers.get(seriesId)?.toArray() || [];
  }

  /** The most recent value of a series, or null when not LIVE. */
  current(seriesId: string): number | null {
    if (this.status !== "LIVE") return null;
    return this.buffers.get(seriesId)?.latest()?.value ?? null;
  }

  /** The most recent raw snapshot, or null when not LIVE. */
  latest(): RawSnapshot | null {
    return this.status === "LIVE" ? this.latestSnapshot : null;
  }

  private reset(): void {
    this.seq++;
    this.clearTimers();
    this.buffers.forEach((b) => b.clear());
    this.previousCounters.clear();
    this.latestSnapshot = null;
    this.failures = 0;
    this.lastTs = -Infinity;
    this.hasHadData = false;
    this.setStatus("STALE");
  }

  private onVisibilityChange = () => {
    if (this.visibility?.hidden) {
      this.pause();
    } else {
      this.resume();
    }
  };

  private poll(): void {
    this.clearTimers();
    const seq = ++this.seq;

    // flag the data as not current if this poll takes too long
    this.staleTimer = setTimeout(() => {
      if (seq === this.seq && this.status === "LIVE") this.setStatus("STALE");
    }, this.intervalMs * 2);

    const timeoutMs = Math.max(MIN_REQUEST_TIMEOUT_MS, this.intervalMs * 2);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Lifeline poll timed out")), timeoutMs);
    });

    let request: Promise<RawSnapshot>;
    try {
      request = Promise.resolve(this.fetchSnapshot());
    } catch (err) {
      request = Promise.reject(err);
    }

    Promise.race([request, timeout])
      .then(
        (snapshot) => {
          if (seq === this.seq) this.onSuccess(snapshot);
        },
        (err) => {
          if (seq === this.seq) this.onFailure(err);
        },
      )
      .finally(() => {
        clearTimeout(timeoutId);
        if (seq !== this.seq || !this.running || this.paused) return;
        this.seq++; // a late response for this poll is now out of order
        this.schedule(this.status === "DISCONNECTED" ? this.backoffMs() : this.intervalMs);
      });
  }

  private schedule(delay: number): void {
    if (this.staleTimer !== undefined) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.poll();
    }, delay);
  }

  private backoffMs(): number {
    const extra = Math.max(0, this.failures - DISCONNECT_AFTER_FAILURES);
    return Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** extra);
  }

  private onSuccess(snapshot: RawSnapshot): void {
    const ts = this.now();
    this.failures = 0;
    this.hasHadData = true;
    this.latestSnapshot = snapshot;
    if (ts <= this.lastTs) {
      // duplicate (same instant) -- keep the data, don't add a point
      this.setStatus("LIVE", true);
      return;
    }
    this.lastTs = ts;
    for (const s of this.series) {
      const raw = toNumber(s.read(snapshot));
      let value = raw;
      if (s.kind === "delta") {
        const previous = this.previousCounters.get(s.id);
        value = raw !== null && previous != null && raw >= previous ? raw - previous : null;
        this.previousCounters.set(s.id, raw);
      }
      this.buffers.get(s.id)?.push({ ts, value });
    }
    this.setStatus("LIVE", true);
  }

  private onFailure(err: unknown): void {
    this.failures++;
    this.appendGap();
    this.setStatus(
      isAuthFailure(err) || this.failures >= DISCONNECT_AFTER_FAILURES ? "DISCONNECTED" : "STALE",
      true,
    );
  }

  // A failed poll still advances time (one empty point per poll), so the
  // trace keeps moving and the outage is visible as a break in the line.
  private appendGap(): void {
    // lastTs tracks real samples only, so a gap never hides the next sample
    const ts = Math.max(this.now(), this.lastTs);
    this.previousCounters.clear();
    this.buffers.forEach((b) => b.push({ ts, value: null }));
  }

  private clearTimers(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
    this.pollTimer = undefined;
    this.staleTimer = undefined;
  }

  private setStatus(status: LifelineStatus, force = false): void {
    if (status === this.status && !force) return;
    this.status = status;
    this.onChange?.();
  }
}
