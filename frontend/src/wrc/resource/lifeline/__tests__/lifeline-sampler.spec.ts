/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import {
  clampInterval,
  LifelineSampler,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  RawSnapshot,
  SamplerOptions,
  SeriesDef,
} from "../lifeline-sampler";

type Pending = { resolve: (v: RawSnapshot) => void; reject: (e: unknown) => void };

const SERIES: SeriesDef[] = [
  { id: "gauge", kind: "gauge", read: (raw) => raw.g as number },
  { id: "delta", kind: "delta", read: (raw) => raw.c as number },
];

const KEY = { provider: "domainA", beanPath: "/api/domainA/domainRuntime/data/DomainRuntime/ServerRuntimes/ms1" };
const INTERVAL = 5000;

class FakeVisibility {
  hidden = false;
  private listeners: (() => void)[] = [];
  addEventListener = (_: string, l: () => void) => {
    this.listeners.push(l);
  };
  removeEventListener = (_: string, l: () => void) => {
    this.listeners = this.listeners.filter((x) => x !== l);
  };
  set(hidden: boolean) {
    this.hidden = hidden;
    this.listeners.forEach((l) => l());
  }
  get listenerCount() {
    return this.listeners.length;
  }
}

describe("LifelineSampler", () => {
  let pending: Pending[];
  let fetchSnapshot: jest.Mock<Promise<RawSnapshot>, []>;
  let visibility: FakeVisibility;
  let sampler: LifelineSampler;

  const flush = () => jest.advanceTimersByTimeAsync(0);
  const respond = async (raw: RawSnapshot) => {
    pending.shift()!.resolve(raw);
    await flush();
  };
  const fail = async (err: unknown = new Error("boom")) => {
    pending.shift()!.reject(err);
    await flush();
  };
  const create = (overrides: Partial<SamplerOptions> = {}) => {
    sampler = new LifelineSampler({
      key: KEY,
      series: SERIES,
      fetchSnapshot,
      intervalMs: INTERVAL,
      visibility: visibility as unknown as SamplerOptions["visibility"],
      ...overrides,
    });
    return sampler;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    pending = [];
    fetchSnapshot = jest.fn(() => new Promise<RawSnapshot>((resolve, reject) => pending.push({ resolve, reject })));
    visibility = new FakeVisibility();
  });

  afterEach(() => {
    sampler?.dispose();
    jest.useRealTimers();
  });

  it("polls once per interval and appends a sample per poll", async () => {
    create().start();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await respond({ g: 10, c: 100 });
    expect(sampler.status).toBe("LIVE");
    expect(sampler.values("gauge")).toEqual([10]);

    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    await respond({ g: 12, c: 103 });
    expect(sampler.values("gauge")).toEqual([10, 12]);
    expect(sampler.current("gauge")).toBe(12);
  });

  it("never has two requests in flight", async () => {
    create().start();
    await jest.advanceTimersByTimeAsync(INTERVAL * 1.5);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await respond({ g: 1, c: 1 });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("plots cumulative counters as the change per poll", async () => {
    create().start();
    for (const c of [100, 103, 103, 110]) {
      await respond({ g: 0, c });
      await jest.advanceTimersByTimeAsync(INTERVAL);
    }
    expect(sampler.values("delta")).toEqual([null, 3, 0, 7]);
  });

  it("treats a counter that goes backwards (server restart) as a gap", async () => {
    create().start();
    for (const c of [500, 510, 4, 9]) {
      await respond({ g: 0, c });
      await jest.advanceTimersByTimeAsync(INTERVAL);
    }
    expect(sampler.values("delta")).toEqual([null, 10, null, 5]);
  });

  it("records a gap for an unavailable metric without affecting the others", async () => {
    create().start();
    await respond({ g: 1, c: 1 });
    await jest.advanceTimersByTimeAsync(INTERVAL);
    await respond({ c: 2 });
    expect(sampler.values("gauge")).toEqual([1, null]);
    expect(sampler.values("delta")).toEqual([null, 1]);
    expect(sampler.status).toBe("LIVE");
  });

  it("goes STALE on a failure, DISCONNECTED on repeated failures, and recovers", async () => {
    create().start();
    await respond({ g: 1, c: 1 });

    await jest.advanceTimersByTimeAsync(INTERVAL);
    await fail();
    expect(sampler.status).toBe("STALE");
    expect(sampler.values("gauge")).toEqual([1, null]);
    expect(sampler.current("gauge")).toBeNull();
    expect(sampler.latest()).toBeNull();

    await jest.advanceTimersByTimeAsync(INTERVAL);
    await fail();
    expect(sampler.status).toBe("DISCONNECTED");

    await jest.advanceTimersByTimeAsync(INTERVAL);
    await respond({ g: 7, c: 9 });
    expect(sampler.status).toBe("LIVE");
    expect(sampler.current("gauge")).toBe(7);
    // the counter delta across the outage is not known
    expect(sampler.values("delta")).toEqual([null, null, null, null]);
  });

  it("is DISCONNECTED straight away when the session is no longer authorized", async () => {
    create().start();
    await fail({ status: 401 });
    expect(sampler.status).toBe("DISCONNECTED");
  });

  it("backs off while disconnected", async () => {
    create().start();
    await fail();
    await jest.advanceTimersByTimeAsync(INTERVAL);
    await fail();
    expect(sampler.status).toBe("DISCONNECTED");
    await jest.advanceTimersByTimeAsync(INTERVAL);
    await fail(); // third failure: next delay doubles
    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(4);
  });

  it("marks data STALE while a poll is taking too long", async () => {
    create().start();
    await respond({ g: 1, c: 1 });
    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(sampler.status).toBe("LIVE");
    await jest.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(sampler.status).toBe("STALE");
  });

  it("times out a hung poll and ignores its late (out-of-order) response", async () => {
    create().start();
    const hung = pending.shift()!;
    await jest.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(sampler.status).toBe("STALE");
    expect(sampler.values("gauge")).toEqual([null]);

    await jest.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    hung.resolve({ g: 99, c: 99 });
    await flush();
    expect(sampler.values("gauge")).toEqual([null]);

    await respond({ g: 3, c: 3 });
    expect(sampler.values("gauge")).toEqual([null, 3]);
  });

  it("starts a fresh history when the server or provider changes", async () => {
    create().start();
    await respond({ g: 1, c: 1 });
    await jest.advanceTimersByTimeAsync(INTERVAL);
    const inFlightForOldServer = pending.shift()!;

    sampler.setKey({ ...KEY, beanPath: "/api/domainA/domainRuntime/data/DomainRuntime/ServerRuntimes/ms2" });
    expect(sampler.values("gauge")).toEqual([]);
    expect(sampler.status).toBe("STALE");
    expect(sampler.hasHadData).toBe(false);

    inFlightForOldServer.resolve({ g: 500, c: 500 });
    await flush();
    expect(sampler.values("gauge")).toEqual([]);

    await respond({ g: 2, c: 2 });
    expect(sampler.values("gauge")).toEqual([2]);

    sampler.setKey({ provider: "domainB", beanPath: KEY.beanPath.replace("domainA", "domainB") });
    expect(sampler.values("gauge")).toEqual([]);
    expect(sampler.getKey().provider).toBe("domainB");
  });

  it("ignores setKey with the same key", async () => {
    create().start();
    await respond({ g: 1, c: 1 });
    sampler.setKey({ ...KEY });
    expect(sampler.values("gauge")).toEqual([1]);
  });

  it("pauses while hidden and resumes with a gap", async () => {
    create().start();
    await respond({ g: 1, c: 1 });

    visibility.set(true);
    expect(sampler.status).toBe("PAUSED");
    await jest.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    visibility.set(false);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    await respond({ g: 2, c: 2 });
    expect(sampler.values("gauge")).toEqual([1, null, 2]);
    expect(sampler.status).toBe("LIVE");
  });

  it("does not poll when started hidden", async () => {
    visibility.hidden = true;
    create().start();
    expect(sampler.status).toBe("PAUSED");
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("stops polling and detaches on dispose", async () => {
    create().start();
    expect(visibility.listenerCount).toBe(1);
    sampler.dispose();
    expect(visibility.listenerCount).toBe(0);
    await respond({ g: 1, c: 1 });
    expect(sampler.values("gauge")).toEqual([]);
    await jest.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not add a point for a duplicate timestamp", async () => {
    create({ now: () => 1000 }).start();
    await respond({ g: 1, c: 1 });
    await jest.advanceTimersByTimeAsync(INTERVAL);
    await respond({ g: 2, c: 2 });
    expect(sampler.values("gauge")).toEqual([1]);
    expect(sampler.status).toBe("LIVE");
  });

  it("keeps a bounded history", async () => {
    create({ capacity: 3 }).start();
    for (let i = 0; i < 6; i++) {
      await respond({ g: i, c: i });
      await jest.advanceTimersByTimeAsync(INTERVAL);
    }
    expect(sampler.values("gauge")).toEqual([3, 4, 5]);
  });

  it("applies a new interval to the next poll", async () => {
    create().start();
    await respond({ g: 1, c: 1 });
    sampler.setIntervalMs(2000);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("clamps the interval", () => {
    expect(clampInterval(10)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(10 * MAX_INTERVAL_MS)).toBe(MAX_INTERVAL_MS);
    expect(clampInterval(NaN)).toBe(5000);
  });
});
