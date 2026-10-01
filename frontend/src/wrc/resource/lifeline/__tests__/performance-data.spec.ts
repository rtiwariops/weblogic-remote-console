/**
 * @license UPL-1.0
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 * The Universal Permissive License (UPL), Version 1.0
 */

import { performanceKeyOf, reloadUrl, toPropertyPath, toSnapshot } from "../performance-data";
import { heapUsed } from "../performance-page";
import { RDJ } from "wrc/shared/typedefs/rdj";

describe("performance data", () => {
  it("derives the provider and bean path from the self link", () => {
    expect(
      performanceKeyOf("/api/My%20Domain/domainRuntime/data/DomainRuntime/ServerRuntimes/ms1?slice=Performance"),
    ).toEqual({
      provider: "My Domain",
      beanPath: "/api/My%20Domain/domainRuntime/data/DomainRuntime/ServerRuntimes/ms1",
    });
  });

  it("gives different keys for the same server in different domains", () => {
    const a = performanceKeyOf("/api/domainA/domainRuntime/data/DomainRuntime/ServerRuntimes/ms1?slice=Performance");
    const b = performanceKeyOf("/api/domainB/domainRuntime/data/DomainRuntime/ServerRuntimes/ms1?slice=Performance");
    expect(a).not.toEqual(b);
  });

  it("rejects links that are not provider data links", () => {
    expect(performanceKeyOf("/somewhere/else")).toBeUndefined();
    expect(performanceKeyOf("/api/")).toBeUndefined();
  });

  it("asks the backend for fresh values and keeps the slice", () => {
    expect(reloadUrl("/api/d/domainRuntime/data/X?slice=Performance")).toBe(
      "/api/d/domainRuntime/data/X?slice=Performance&reload=true",
    );
  });

  it("flattens slice data", () => {
    const rdj = {
      data: {
        "JVMRuntime.HeapFreeCurrent": { value: 10 },
        "ThreadPoolRuntime.QueueLength": { value: 0 },
      },
    } as unknown as RDJ;
    expect(toSnapshot(rdj)).toEqual({
      "JVMRuntime.HeapFreeCurrent": 10,
      "ThreadPoolRuntime.QueueLength": 0,
    });
    expect(toSnapshot({} as RDJ)).toEqual({});
  });

  it("reads the property names of a real WLS 14.1.2 Servers > ms1 > Performance response", () => {
    const rdj = {
      data: {
        ServerRuntime_ThreadPoolRuntime_ExecuteThreadIdleCount: { value: 0 },
        ServerRuntime_ThreadPoolRuntime_QueueLength: { value: 0 },
        ServerRuntime_ThreadPoolRuntime_CompletedRequestCount: { value: 20775 },
        ServerRuntime_JVMRuntime_HeapFreeCurrent: { value: 389467928 },
        ServerRuntime_JVMRuntime_HeapSizeCurrent: { value: 849346560 },
      },
    } as unknown as RDJ;
    const snapshot = toSnapshot(rdj);
    expect(snapshot).toEqual({
      "ThreadPoolRuntime.ExecuteThreadIdleCount": 0,
      "ThreadPoolRuntime.QueueLength": 0,
      "ThreadPoolRuntime.CompletedRequestCount": 20775,
      "JVMRuntime.HeapFreeCurrent": 389467928,
      "JVMRuntime.HeapSizeCurrent": 849346560,
    });
    expect(heapUsed(snapshot)).toBe(849346560 - 389467928);
  });

  it("maps form field names to property paths", () => {
    expect(toPropertyPath("JVMRuntime_HeapFreeCurrent")).toBe("JVMRuntime.HeapFreeCurrent");
    expect(toPropertyPath("ServerRuntime_JVMRuntime_HeapFreeCurrent")).toBe("JVMRuntime.HeapFreeCurrent");
    expect(toPropertyPath("JVMRuntime.HeapFreeCurrent")).toBe("JVMRuntime.HeapFreeCurrent");
  });

  it("plots Memory Usage as heap in use", () => {
    expect(heapUsed({ "JVMRuntime.HeapSizeCurrent": 100, "JVMRuntime.HeapFreeCurrent": 30 })).toBe(70);
    expect(heapUsed({ "JVMRuntime.HeapSizeCurrent": 100 })).toBeNull();
  });
});
