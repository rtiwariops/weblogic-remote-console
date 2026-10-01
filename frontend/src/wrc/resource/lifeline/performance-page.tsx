/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import "css!wrc/resource/lifeline/lifeline.css";
import { useEffect, useRef, useState } from "preact/hooks";
import * as t from "ojL10n!wrc/shared/resources/nls/frontend";
import {
  GraphMode,
  LifelineGraph,
  LARGE_GRAPH_HEIGHT,
  SMALL_GRAPH_HEIGHT,
  GRAPH_WIDTH,
  POINT_SPACING,
} from "./lifeline-graph";
import { LifelineSampler, RawSnapshot, SeriesDef, SeriesKey } from "./lifeline-sampler";

/** Where the Performance page gets its data; see performance-data.ts. */
export interface PerformanceSource {
  key: SeriesKey;
  fetchSnapshot: () => Promise<RawSnapshot>;
  forceGC?: () => Promise<unknown>;
}

// Runtime attributes read by the ServerRuntime "Performance" slice
export const IDLE_THREADS = "ThreadPoolRuntime.ExecuteThreadIdleCount";
export const QUEUE_LENGTH = "ThreadPoolRuntime.QueueLength";
export const COMPLETED_REQUESTS = "ThreadPoolRuntime.CompletedRequestCount";
export const HEAP_FREE = "JVMRuntime.HeapFreeCurrent";
export const HEAP_SIZE = "JVMRuntime.HeapSizeCurrent";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// Memory Usage is heap in use (size - free): the 8.1 graph rises as the
// heap fills and drops at each garbage collection.
export const heapUsed = (raw: RawSnapshot): number | null => {
  const size = num(raw[HEAP_SIZE]);
  const free = num(raw[HEAP_FREE]);
  return size !== null && free !== null ? Math.max(0, size - free) : null;
};

export const PERFORMANCE_SERIES: SeriesDef[] = [
  // requests completed during each poll period
  { id: "throughput", kind: "delta", read: (raw) => num(raw[COMPLETED_REQUESTS]) },
  { id: "queueLength", kind: "gauge", read: (raw) => num(raw[QUEUE_LENGTH]) },
  { id: "memoryUsage", kind: "gauge", read: heapUsed },
];

// one point per 2px across the panel
export const HISTORY_POINTS = Math.ceil(GRAPH_WIDTH / POINT_SPACING);

// redraw rate for the time axis; display only, never polls the server
const CLOCK_TICK_MS = 1000;

export const POLL_INTERVAL_STORAGE_KEY = "wrc.lifeline.pollIntervalMs";

const loadPollInterval = (): number | undefined => {
  try {
    const v = Number(window.localStorage.getItem(POLL_INTERVAL_STORAGE_KEY));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
};

const savePollInterval = (ms: number) => {
  try {
    window.localStorage.setItem(POLL_INTERVAL_STORAGE_KEY, String(ms));
  } catch {
    // preference is just not remembered
  }
};

// page outline with a pencil stroke across its upper-right corner
const PreferencesIcon = () => (
  <svg class="wrc-lifeline-prefs-icon" width="16" height="15" viewBox="0 0 16 15" aria-hidden="true">
    <path d="M1.5 4.5h8v9h-8z" fill="#ffffff" stroke="#404040" />
    <path d="M5 11l1-3 7-7 2 2-7 7z" fill="#808080" stroke="#202020" stroke-linejoin="round" />
    <path d="M5 11l1.6-0.6-1-1z" fill="#202020" />
  </svg>
);

type Props = {
  source: PerformanceSource;
};

export const PerformancePage = ({ source }: Props) => {
  const labels = t["wrc-lifeline"];
  const [, setTick] = useState(0);
  const [showPrefs, setShowPrefs] = useState(false);
  const [gcRunning, setGcRunning] = useState(false);
  const [gcFailed, setGcFailed] = useState(false);
  const samplerRef = useRef<LifelineSampler | null>(null);
  const heapSizeRef = useRef<number | undefined>(undefined);
  const [intervalInput, setIntervalInput] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Advances the time axis so a stalled or disconnected server shows up as
  // a growing blank area. Display only: it never triggers a request.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // One sampler per page instance; it lives exactly as long as the page.
  useEffect(() => {
    const sampler = new LifelineSampler({
      key: source.key,
      series: PERFORMANCE_SERIES,
      fetchSnapshot: () => source.fetchSnapshot(),
      intervalMs: loadPollInterval(),
      capacity: HISTORY_POINTS,
      // Like the 8.1 console's graph applet, keep sampling while the page is
      // open even if the window is covered or in the background; polling
      // stops when the user leaves the page (dispose on unmount).
      visibility: null,
      onChange: () => {
        setNow(Date.now());
        setTick((n) => n + 1);
      },
    });
    samplerRef.current = sampler;
    heapSizeRef.current = undefined;
    setIntervalInput(String(sampler.getIntervalMs()));
    sampler.start();
    return () => {
      sampler.dispose();
      samplerRef.current = null;
    };
    // a different provider or server is a different page
  }, [source.key.provider, source.key.beanPath]);

  const sampler = samplerRef.current;
  const latest = sampler?.latest() || null;
  const heapSize = latest ? num(latest[HEAP_SIZE]) : null;
  if (heapSize !== null) heapSizeRef.current = heapSize;

  const status = sampler?.status;
  const windowMs = HISTORY_POINTS * (sampler?.getIntervalMs() ?? 0);
  const graph = (id: string, title: string, height: number, mode: GraphMode, max?: number) => (
    <LifelineGraph
      title={title}
      samples={sampler?.samples(id) || []}
      now={now}
      windowMs={windowMs}
      current={sampler?.current(id) ?? null}
      max={max}
      mode={mode}
      height={height}
    />
  );
  const notCurrent = !!sampler && (status === "DISCONNECTED" || (status === "STALE" && sampler.hasHadData));
  const idleThreads = latest ? num(latest[IDLE_THREADS]) : null;

  const onForceGC = () => {
    if (!source.forceGC) return;
    setGcRunning(true);
    setGcFailed(false);
    source
      .forceGC()
      .catch(() => setGcFailed(true))
      .finally(() => setGcRunning(false));
  };

  const onApplyPrefs = (e: Event) => {
    e.preventDefault();
    if (!sampler) return;
    sampler.setIntervalMs(Number(intervalInput));
    savePollInterval(sampler.getIntervalMs());
    setIntervalInput(String(sampler.getIntervalMs()));
    setShowPrefs(false);
  };

  return (
    <div class="wrc-lifeline-page">
      <table class="wrc-lifeline-table" role="presentation">
        <tbody>
          <tr>
            <td class="wrc-lifeline-label">{labels.idleThreads}</td>
            <td class="wrc-lifeline-value">{idleThreads === null ? "—" : idleThreads}</td>
          </tr>
          <tr>
            <td class="wrc-lifeline-label">{labels.oldestPendingRequest}</td>
            <td class="wrc-lifeline-value">{labels.notAvailable}</td>
          </tr>
          <tr>
            <td class="wrc-lifeline-label">{labels.throughput}</td>
            <td class="wrc-lifeline-graph-cell">
              {graph("throughput", labels.throughput, SMALL_GRAPH_HEIGHT, "spike")}
            </td>
          </tr>
          <tr>
            <td class="wrc-lifeline-label">{labels.queueLength}</td>
            <td class="wrc-lifeline-graph-cell">
              {graph("queueLength", labels.queueLength, SMALL_GRAPH_HEIGHT, "line")}
            </td>
          </tr>
          <tr>
            <td class="wrc-lifeline-label">{labels.memoryUsage}</td>
            <td class="wrc-lifeline-graph-cell">
              {graph("memoryUsage", labels.memoryUsage, LARGE_GRAPH_HEIGHT, "line", heapSizeRef.current)}
            </td>
          </tr>
        </tbody>
      </table>

      {notCurrent ? (
        <div class="wrc-lifeline-not-current" role="status">
          {status === "DISCONNECTED" ? labels.disconnected : labels.stale}
        </div>
      ) : (
        <></>
      )}

      <div class="wrc-lifeline-actions">
        <button
          type="button"
          class="wrc-lifeline-button"
          disabled={!source.forceGC || gcRunning}
          onClick={onForceGC}
        >
          {labels.forceGC}
        </button>
        {gcFailed ? <span class="wrc-lifeline-gc-failed">{labels.gcFailed}</span> : <></>}
      </div>

      <div class="wrc-lifeline-prefs">
        <a
          href="#"
          class="wrc-lifeline-prefs-link"
          onClick={(e) => {
            e.preventDefault();
            setShowPrefs(!showPrefs);
          }}
        >
          <PreferencesIcon />
          {labels.modifyGraphingPreferences}
        </a>
        {showPrefs ? (
          <form class="wrc-lifeline-prefs-form" onSubmit={onApplyPrefs}>
            <label>
              {labels.pollForGraphData}{" "}
              <input
                type="number"
                min="1000"
                max="60000"
                step="500"
                value={intervalInput}
                onInput={(e) => setIntervalInput((e.target as HTMLInputElement).value)}
              />{" "}
              {labels.milliseconds}
            </label>{" "}
            <button type="submit" class="wrc-lifeline-button">
              {labels.apply}
            </button>
          </form>
        ) : (
          <></>
        )}
      </div>
    </div>
  );
};

export default PerformancePage;
