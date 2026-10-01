/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import { h } from "preact";
import { useMemo } from "preact/hooks";
import { getDataComponent } from "wrc/shared/model/transport";
import { PropertyValueHolder, RDJ } from "wrc/shared/typedefs/rdj";
import { RawSnapshot, SeriesKey } from "./lifeline-sampler";
import { PerformancePage, PerformanceSource } from "./performance-page";

/** Adds reload=true so the backend reads fresh values from WebLogic. */
export const reloadUrl = (url: string): string => {
  const u = new URL(url, window.location.href);
  u.searchParams.set("reload", "true");
  return u.pathname + u.search + u.hash;
};

/** Flattens an RDJ's slice data to { "JVMRuntime.HeapFreeCurrent": 123, ... }. */
export const toSnapshot = (rdj: RDJ): RawSnapshot => {
  const snapshot: RawSnapshot = {};
  const data = rdj?.data;
  if (data && !Array.isArray(data)) {
    for (const [name, holder] of Object.entries(data as Record<string, PropertyValueHolder>)) {
      snapshot[name] = holder?.value;
    }
  }
  return snapshot;
};

/**
 * Derives the sample identity from a page's self link,
 * "/api/<provider>/<root>/data/<bean path>?slice=...".
 * The backend puts the real provider (domain connection) name in the link,
 * so samples from different domains can never share a key.
 */
export const performanceKeyOf = (selfUrl: string): SeriesKey | undefined => {
  const path = new URL(selfUrl, window.location.href).pathname;
  const match = /^\/api\/([^/]+)\/.+/.exec(path);
  return match ? { provider: decodeURIComponent(match[1]), beanPath: path } : undefined;
};

// forceGC is intentionally not provided until the runGC action path has
// been verified against a live server; the button renders disabled.
export const createPerformanceSource = (selfUrl: string, seriesKey: SeriesKey): PerformanceSource => ({
  key: seriesKey,
  fetchSnapshot: async () => toSnapshot(await getDataComponent<RDJ>(reloadUrl(selfUrl))),
});

/** Renders the Performance page for a ServerRuntime "Performance" slice. */
export const PerformanceSlice = ({
  selfUrl,
  seriesKey,
}: {
  selfUrl: string;
  seriesKey: SeriesKey;
}) => {
  const source = useMemo(
    () => createPerformanceSource(selfUrl, seriesKey),
    [selfUrl, seriesKey.provider, seriesKey.beanPath],
  );

  return h(PerformancePage, { source });
};
