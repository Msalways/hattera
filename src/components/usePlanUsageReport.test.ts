// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanUsageReport } from "./planUsageReport";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const calls = vi.hoisted(() => [] as Array<{ refresh: boolean; result: Deferred<PlanUsageReport> }>);
vi.mock("@/state/store", () => ({
  api: vi.fn((url: string) => {
    const result = deferred<PlanUsageReport>();
    calls.push({ refresh: url.includes("refresh=1"), result });
    return result.promise;
  }),
}));

const { clearPlanUsageReportCache, usePlanUsageReport } = await import("./usePlanUsageReport");

function report(id: string, fetchedAt = "2026-10-02T09:00:00Z"): PlanUsageReport {
  return {
    fetchedAt,
    providers: [{
      id, name: id, driver: "claude", plan: "Pro", ok: true, error: null,
      fiveHour: { available: true, remainingPercent: 50, usedPercent: 50, resetsAt: null },
      weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
      extra: [], models: [],
    }],
  };
}

afterEach(() => {
  clearPlanUsageReportCache();
  calls.length = 0;
  document.body.innerHTML = "";
});

describe("usePlanUsageReport", () => {
  it("ignores delayed responses that resolve after a newer refresh", async () => {
    let state!: ReturnType<typeof usePlanUsageReport>;
    function Probe() {
      state = usePlanUsageReport({ enabled: false });
      return null;
    }
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    flushSync(() => root.render(createElement(Probe)));
    expect(state.report).toBeNull();

    flushSync(() => { void state.load(false); });
    flushSync(() => { void state.load(true); });
    expect(calls).toHaveLength(2);
    expect(calls[0].refresh).toBe(false);
    expect(calls[1].refresh).toBe(true);

    await act(async () => {
      calls[1].result.resolve(report("new", "2026-10-02T09:02:00Z"));
      await calls[1].result.promise;
    });
    expect(state.report?.fetchedAt).toBe("2026-10-02T09:02:00Z");
    expect(state.loading).toBe(false);

    await act(async () => {
      calls[0].result.resolve(report("old", "2026-10-02T09:00:00Z"));
      await calls[0].result.promise;
    });
    expect(state.report?.fetchedAt).toBe("2026-10-02T09:02:00Z");
    expect(state.report?.providers[0]?.id).toBe("new");

    flushSync(() => root.unmount());
  });

  it("does not apply a response after unmount", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let state!: ReturnType<typeof usePlanUsageReport>;
    function Probe() {
      state = usePlanUsageReport({ enabled: false });
      return null;
    }
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    flushSync(() => root.render(createElement(Probe)));
    flushSync(() => { void state.load(false); });
    expect(calls).toHaveLength(1);

    flushSync(() => root.unmount());
    await act(async () => {
      calls[0].result.resolve(report("late"));
      await calls[0].result.promise;
    });
    console.error = original;

    const text = errors.map((entry) => String(entry)).join("\n");
    expect(text).not.toMatch(/unmounted|state update/i);
  });
});

describe('independent cache freshness acceptance', () => {
  it('does not apply an obsolete in-flight cached request to a reopened active view', async () => {
    let state!: ReturnType<typeof usePlanUsageReport>;
    function Probe({enabled}: {enabled: boolean}) { state = usePlanUsageReport({enabled}); return null; }
    const first = createRoot(document.body.appendChild(document.createElement('div')));
    flushSync(() => first.render(createElement(Probe,{enabled:false})));
    flushSync(() => { void state.load(false); void state.load(true); });
    await act(async () => { calls[1].result.resolve(report('new')); await calls[1].result.promise; });
    flushSync(() => first.unmount());
    const reopened = createRoot(document.body.appendChild(document.createElement('div')));
    try {
      flushSync(() => reopened.render(createElement(Probe,{enabled:true})));
      await act(async () => { calls[0].result.resolve(report('old')); await calls[0].result.promise; });
      expect(state.report?.providers[0]?.id).toBe('new');
    } finally { flushSync(() => reopened.unmount()); }
  });
  it('does not seed a newly opened view with an older late response', async () => {
    let state!: ReturnType<typeof usePlanUsageReport>;
    function Probe() { state = usePlanUsageReport({ enabled: false }); return null; }
    const first = createRoot(document.body.appendChild(document.createElement('div')));
    flushSync(() => first.render(createElement(Probe)));
    flushSync(() => { void state.load(false); void state.load(true); });
    await act(async () => { calls[1].result.resolve(report('new')); await calls[1].result.promise; });
    await act(async () => { calls[0].result.resolve(report('old')); await calls[0].result.promise; });
    expect(state.report?.providers[0]?.id).toBe('new');
    flushSync(() => first.unmount());
    const reopened = createRoot(document.body.appendChild(document.createElement('div')));
    try {
      flushSync(() => reopened.render(createElement(Probe)));
      expect(state.report?.providers[0]?.id).toBe('new');
    } finally { flushSync(() => reopened.unmount()); }
  });
});
