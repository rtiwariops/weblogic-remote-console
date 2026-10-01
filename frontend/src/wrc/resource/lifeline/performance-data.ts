/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import { h } from "preact";
import { useMemo } from "preact/hooks";
import { _post, doAction, getDataComponent, parseResponseJson } from "wrc/shared/model/transport";
import { isSuccessful } from "wrc/shared/messages";
import { Action } from "wrc/shared/typedefs/pdj";
import { PropertyValueHolder, RDJ, StatusData } from "wrc/shared/typedefs/rdj";
import { Response as MessageResponse } from "wrc/shared/typedefs/common";
import { RawSnapshot, SeriesKey } from "./lifeline-sampler";
import { PerformancePage, PerformanceSource } from "./performance-page";

/** Adds reload=true so the backend reads fresh values from WebLogic. */
export const reloadUrl = (url: string): string => {
  const u = new URL(url, window.location.href);
  u.searchParams.set("reload", "true");
  return u.pathname + u.search + u.hash;
};

// On the Monitoring Tree's Servers > <server> page the slice belongs to the
// combined running-server bean, which renames every ServerRuntime property
// to "ServerRuntime.<name>" (see CombinedServerRuntimeMBeanYamlReader).
const DELEGATED_SERVER_RUNTIME_PREFIX = "ServerRuntime.";

/**
 * Maps an RDJ data key back to its property path. The backend names each
 * value after the property path with "_" separators
 * (BeanPropertyDefImpl.getFormFieldName), e.g.
 * "ServerRuntime_JVMRuntime_HeapFreeCurrent" -> "JVMRuntime.HeapFreeCurrent".
 */
export const toPropertyPath = (formFieldName: string): string => {
  const path = formFieldName.split("_").join(".");
  return path.startsWith(DELEGATED_SERVER_RUNTIME_PREFIX)
    ? path.substring(DELEGATED_SERVER_RUNTIME_PREFIX.length)
    : path;
};

/** Flattens an RDJ's slice data to { "JVMRuntime.HeapFreeCurrent": 123, ... }. */
export const toSnapshot = (rdj: RDJ): RawSnapshot => {
  const snapshot: RawSnapshot = {};
  const data = rdj?.data;
  if (data && !Array.isArray(data)) {
    for (const [name, holder] of Object.entries(data as Record<string, PropertyValueHolder>)) {
      snapshot[toPropertyPath(name)] = holder?.value;
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

// ---------------------------------------------------------------------------
// Force garbage collection
//
// The runGC action belongs to the server's JVM Runtime page, not to the
// Performance page. Its address is never built here: on each click it is
// discovered from what the server hands out --
//   Performance page -> its nav tree position and the nav tree service
//   nav tree         -> the server's JVM Runtime node and its link
//   JVM Runtime page -> actions.runGC.invoker
// Nothing is invoked unless every step resolves for the same provider and
// server, and nothing is cached between clicks.
// ---------------------------------------------------------------------------

export const JVM_RUNTIME_NODE = "JVMRuntime";
export const RUN_GC_ACTION = "runGC";

/** Raised when the runGC action cannot be discovered; nothing was invoked. */
export class GarbageCollectionUnavailable extends Error {
  readonly unavailable = true;
}

type NavNode = {
  name?: string;
  resourceData?: { resourceData?: string };
  contents?: NavNode[];
};

type PageRdj = RDJ & { navigation?: string; statusData?: StatusData };

export interface GcTransport {
  getJson: <T>(url: string) => Promise<T>;
  postNavtree: (url: string, body: NavNode) => Promise<NavNode>;
  invokeAction: (url: string) => Promise<MessageResponse>;
}

const defaultGcTransport: GcTransport = {
  getJson: (url) => getDataComponent(url),
  postNavtree: async (url, body) => parseResponseJson<NavNode>(await _post(url, JSON.stringify(body)), url),
  invokeAction: async (url) =>
    parseResponseJson<MessageResponse>(await doAction(url, { name: RUN_GC_ACTION } as Action), url),
};

const unavailable = (why: string): never => {
  throw new GarbageCollectionUnavailable(why);
};

const sameKey = (url: string | undefined, key: SeriesKey): boolean => {
  const k = url ? performanceKeyOf(url) : undefined;
  return !!k && k.provider === key.provider && k.beanPath === key.beanPath;
};

const sameProvider = (url: string | undefined, key: SeriesKey): boolean =>
  !!url && performanceKeyOf(url)?.provider === key.provider;

/** Sparse nav tree request that expands each of the given paths. */
export const expandPaths = (paths: string[][]): NavNode => {
  const root: NavNode & { expanded?: boolean } = {};
  for (const path of paths) {
    let node = root as NavNode & { expanded?: boolean };
    for (const name of path) {
      node.contents = node.contents || [];
      let child = node.contents.find((c) => c.name === name) as (NavNode & { expanded?: boolean }) | undefined;
      if (!child) {
        child = { name };
        node.contents.push(child);
      }
      child.expanded = true;
      node = child;
    }
  }
  return root;
};

const childAt = (tree: NavNode, path: string[]): NavNode | undefined => {
  let node: NavNode | undefined = tree;
  for (const name of path) node = node?.contents?.find((c) => c.name === name);
  return node;
};

/**
 * Finds the runGC invoker for the server shown by a Performance page.
 * Throws GarbageCollectionUnavailable if any step does not resolve,
 * including a request failing (expired session, server unreachable).
 */
export const discoverRunGC = async (
  selfUrl: string,
  key: SeriesKey,
  transport: GcTransport = defaultGcTransport,
): Promise<string> => {
  try {
    return await discover(selfUrl, key, transport);
  } catch (err) {
    if (err instanceof GarbageCollectionUnavailable) throw err;
    throw new GarbageCollectionUnavailable(`discovery request failed: ${(err as Error)?.message}`);
  }
};

const discover = async (selfUrl: string, key: SeriesKey, transport: GcTransport): Promise<string> => {
  // 1. the Performance page: its nav tree position and the nav tree service
  const page = await transport.getJson<PageRdj>(selfUrl);
  if (!sameKey(page?.self?.resourceData, key)) unavailable("page no longer shows this server");
  const navigation = typeof page.navigation === "string" ? page.navigation.split("/").filter((s) => s) : [];
  if (!navigation.length) unavailable("no nav tree position");
  const current = page.statusData?.providers?.current as ({ name?: string } & StatusData["providers"]["current"]) | undefined;
  if (!current || current.name !== key.provider) unavailable("provider changed");
  const rootName = new URL(selfUrl, window.location.href).pathname.split("/")[3];
  const navtreeUrl = current!.roots?.find((r) => r.name === rootName)?.navtree;
  if (typeof navtreeUrl !== "string" || !navtreeUrl) unavailable("no nav tree service");

  // 2. the server's node, then its folders, as the console's nav tree shows them
  const first = await transport.postNavtree(navtreeUrl!, expandPaths([navigation]));
  const server = childAt(first, navigation);
  if (!server || !sameKey(server.resourceData?.resourceData, key)) unavailable("server node not found");
  const folders = (server!.contents || []).map((c) => c.name).filter((n): n is string => !!n);
  const second = await transport.postNavtree(
    navtreeUrl!,
    expandPaths([navigation, ...folders.map((f) => [...navigation, f])]),
  );
  const serverAgain = childAt(second, navigation);
  const jvmNode = [serverAgain, ...(serverAgain?.contents || [])]
    .flatMap((n) => n?.contents || [])
    .find((n) => n.name === JVM_RUNTIME_NODE);
  const jvmUrl = jvmNode?.resourceData?.resourceData;
  if (!jvmUrl || !sameProvider(jvmUrl, key)) unavailable("JVM Runtime node not found");

  // 3. the JVM Runtime page's own action invoker
  const jvm = await transport.getJson<RDJ>(jvmUrl!);
  const invoker = jvm?.actions?.[RUN_GC_ACTION]?.invoker?.resourceData;
  if (typeof invoker !== "string" || !invoker || !sameProvider(invoker, key)) unavailable("runGC action not offered");
  return invoker!;
};

/** Discovers and invokes runGC; resolves when the server reports success. */
export const forceGarbageCollection = async (
  selfUrl: string,
  key: SeriesKey,
  transport: GcTransport = defaultGcTransport,
): Promise<void> => {
  const invoker = await discoverRunGC(selfUrl, key, transport);
  const result = await transport.invokeAction(invoker);
  if (!isSuccessful(result)) throw new Error("runGC reported an error");
};

export const createPerformanceSource = (selfUrl: string, seriesKey: SeriesKey): PerformanceSource => ({
  key: seriesKey,
  fetchSnapshot: async () => toSnapshot(await getDataComponent<RDJ>(reloadUrl(selfUrl))),
  forceGC: () => forceGarbageCollection(selfUrl, seriesKey),
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
