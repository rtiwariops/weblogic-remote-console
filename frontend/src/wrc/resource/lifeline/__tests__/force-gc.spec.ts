/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import {
  discoverRunGC,
  expandPaths,
  forceGarbageCollection,
  GarbageCollectionUnavailable,
  GcTransport,
} from "../performance-data";

// Shapes recorded from a live WLS 14.1.2 domain (Servers > ms1). The JVM
// Runtime and invoker links below are deliberately unusual, to prove they
// are used exactly as received and never rebuilt.
const SELF = "/api/Conn-1/domainRuntime/data/DomainRuntime/CombinedServerRuntimes/ms1?slice=Performance";
const KEY = { provider: "Conn-1", beanPath: "/api/Conn-1/domainRuntime/data/DomainRuntime/CombinedServerRuntimes/ms1" };
const NAVTREE = "/api/Conn-1/domainRuntime/navtree";
const JVM_URL = "/api/Conn-1/domainRuntime/data/Some/Server/Given/Path/JVM";
const INVOKER = "/api/Conn-1/domainRuntime/data/Some/Server/Given/Path/JVM?slice=General&action=runGC&token=xyz";

const page = (overrides: Record<string, unknown> = {}) => ({
  self: { resourceData: SELF },
  navigation: "Environment/CombinedServerRuntimes/ms1",
  statusData: {
    providers: {
      current: {
        name: "Conn-1",
        roots: [
          { name: "edit", navtree: "/api/Conn-1/edit/navtree" },
          { name: "domainRuntime", navtree: NAVTREE },
        ],
      },
    },
  },
  ...overrides,
});

const serverNode = (contents: unknown[]) => ({
  contents: [{
    name: "Environment",
    contents: [{
      name: "CombinedServerRuntimes",
      contents: [{ name: "ms1", resourceData: { resourceData: KEY.beanPath }, contents }],
    }],
  }],
});

const folders = [{ name: "Tasks" }, { name: "Environment" }, { name: "Diagnostics" }];
const expandedFolders = (jvmNode: unknown) => [
  { name: "Tasks", contents: [] },
  { name: "Environment", contents: [jvmNode, { name: "ServerChannelRuntimes", resourceData: { resourceData: "/api/Conn-1/x" } }] },
  { name: "Diagnostics", contents: [] },
];
const JVM_NODE = { name: "JVMRuntime", resourceData: { resourceData: JVM_URL } };

type Fake = {
  transport: GcTransport;
  getJson: jest.Mock;
  postNavtree: jest.Mock;
  invokeAction: jest.Mock;
};

const fake = (opts: {
  page?: unknown;
  first?: unknown;
  second?: unknown;
  jvm?: unknown;
  result?: unknown;
  failGet?: unknown;
} = {}): Fake => {
  const getJson = jest.fn(async (url: string) => {
    if (opts.failGet) throw opts.failGet;
    if (url === SELF) return opts.page ?? page();
    if (url === JVM_URL) return opts.jvm ?? { actions: { runGC: { invoker: { resourceData: INVOKER } } } };
    throw Object.assign(new Error("404"), { status: 404 });
  });
  const postNavtree = jest
    .fn()
    .mockResolvedValueOnce(opts.first ?? serverNode(folders))
    .mockResolvedValueOnce(opts.second ?? serverNode(expandedFolders(JVM_NODE)));
  const invokeAction = jest.fn(async () => opts.result ?? { messages: [{ severity: "SUCCESS", message: "Started garbage collection." }] });
  return { transport: { getJson, postNavtree, invokeAction } as unknown as GcTransport, getJson, postNavtree, invokeAction };
};

const expectUnavailable = async (f: Fake) => {
  await expect(forceGarbageCollection(SELF, KEY, f.transport)).rejects.toBeInstanceOf(GarbageCollectionUnavailable);
  expect(f.invokeAction).not.toHaveBeenCalled();
};

describe("force garbage collection discovery", () => {
  it("finds the JVM Runtime node through the server's nav tree", async () => {
    const f = fake();
    await discoverRunGC(SELF, KEY, f.transport);
    // the nav tree service comes from the page's status data, for this page's root
    expect(f.postNavtree).toHaveBeenNthCalledWith(1, NAVTREE, expandPaths([["Environment", "CombinedServerRuntimes", "ms1"]]));
    expect(f.postNavtree).toHaveBeenNthCalledWith(
      2,
      NAVTREE,
      expandPaths([
        ["Environment", "CombinedServerRuntimes", "ms1"],
        ["Environment", "CombinedServerRuntimes", "ms1", "Tasks"],
        ["Environment", "CombinedServerRuntimes", "ms1", "Environment"],
        ["Environment", "CombinedServerRuntimes", "ms1", "Diagnostics"],
      ]),
    );
    // the JVM Runtime page is fetched at exactly the link the nav tree gave
    expect(f.getJson).toHaveBeenCalledWith(JVM_URL);
  });

  it("takes runGC from actions.runGC.invoker.resourceData and invokes exactly that", async () => {
    expect(await discoverRunGC(SELF, KEY, fake().transport)).toBe(INVOKER);
    const f = fake();
    await forceGarbageCollection(SELF, KEY, f.transport);
    expect(f.invokeAction).toHaveBeenCalledTimes(1);
    expect(f.invokeAction).toHaveBeenCalledWith(INVOKER);
  });

  it("never builds a JVMRuntime or action URL of its own", async () => {
    const f = fake();
    await forceGarbageCollection(SELF, KEY, f.transport);
    // every URL used, in the order the requests were made
    const used = [f.getJson, f.postNavtree, f.invokeAction]
      .flatMap((m) => m.mock.calls.map((c, i) => ({ url: c[0] as string, order: m.mock.invocationCallOrder[i] })))
      .sort((x, y) => x.order - y.order)
      .map((x) => x.url);
    expect(used).toEqual([SELF, NAVTREE, NAVTREE, JVM_URL, INVOKER]);
    expect(used.some((u) => /\/ServerRuntime\/JVMRuntime/.test(u))).toBe(false);
  });

  it("rediscovers on every click (nothing cached)", async () => {
    const f = fake();
    await forceGarbageCollection(SELF, KEY, f.transport);
    f.postNavtree
      .mockResolvedValueOnce(serverNode(folders))
      .mockResolvedValueOnce(serverNode(expandedFolders(JVM_NODE)));
    await forceGarbageCollection(SELF, KEY, f.transport);
    expect(f.getJson).toHaveBeenCalledTimes(4);
    expect(f.postNavtree).toHaveBeenCalledTimes(4);
    expect(f.invokeAction).toHaveBeenCalledTimes(2);
  });

  it("does not invoke anything when the JVM Runtime node is missing", async () => {
    await expectUnavailable(fake({ second: serverNode(expandedFolders({ name: "SomethingElse" })) }));
  });

  it("does not invoke anything when runGC is not offered", async () => {
    await expectUnavailable(fake({ jvm: { actions: {} } }));
    await expectUnavailable(fake({ jvm: {} }));
  });

  it("does not invoke anything on malformed metadata", async () => {
    await expectUnavailable(fake({ jvm: { actions: { runGC: { invoker: { resourceData: 42 } } } } }));
    await expectUnavailable(fake({ page: page({ navigation: undefined }) }));
    await expectUnavailable(fake({ page: page({ statusData: undefined }) }));
    await expectUnavailable(fake({ first: { contents: "nonsense" } }));
  });

  it("does not invoke anything after a provider switch", async () => {
    const switched = page();
    (switched.statusData.providers.current as { name: string }).name = "Other-Domain";
    await expectUnavailable(fake({ page: switched }));
  });

  it("does not invoke anything if the page now shows a different server", async () => {
    await expectUnavailable(
      fake({ page: page({ self: { resourceData: SELF.replace("ms1", "ms2") } }) }),
    );
  });

  it("does not invoke an action link that points at another provider", async () => {
    await expectUnavailable(
      fake({ jvm: { actions: { runGC: { invoker: { resourceData: INVOKER.replace("Conn-1", "Other") } } } } }),
    );
  });

  it("does not invoke anything when the session has expired or the server is unreachable", async () => {
    await expectUnavailable(fake({ failGet: Object.assign(new Error("Unauthorized"), { status: 401 }) }));
    await expectUnavailable(fake({ failGet: new Error("Failed to fetch") }));
  });

  it("reports a failure when the server rejects runGC", async () => {
    const f = fake({ result: { messages: [{ severity: "ERROR", message: "Garbage collection failed." }] } });
    await expect(forceGarbageCollection(SELF, KEY, f.transport)).rejects.not.toBeInstanceOf(GarbageCollectionUnavailable);
    expect(f.invokeAction).toHaveBeenCalledWith(INVOKER);
  });
});
