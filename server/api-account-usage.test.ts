import { afterEach, describe, expect, it, vi } from "vitest";
import { apiAccountUsage, apiReportingRoute, kimiApiMetrics, minimaxApiMetrics } from "./api-account-usage.ts";

afterEach(() => vi.unstubAllGlobals());

describe("API account reporting", () => {
  it("reads every Kimi window, preserves zero and reports wallet currency without guessing monthly duration", () => {
    const metrics = kimiApiMetrics({ usages: { limit_5h: { used_ratio: 0, reset_time: "2030-01-01T00:00:00Z" }, limit_7d: { used_ratio: 1 }, limit_month_total: { used_ratio: 0.4 }, limit_month_code: { used_ratio: 0.2 }, future_window: { used_ratio: 0.1 } },
      boosterWallet: { balance: { type: "BOOSTER", amount: 500_000_000, amountLeft: 0 }, monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { currency: "CNY", priceInCents: 1000 }, monthlyUsed: { currency: "CNY", priceInCents: 0 } } });
    expect(metrics).toHaveLength(7);
    expect(metrics[0]).toMatchObject({ used: 0, remaining: 100, windowSeconds: 18000 });
    expect(metrics[1]).toMatchObject({ used: 100, remaining: 0 });
    expect(metrics[2]).toMatchObject({ label: "Monthly total", windowSeconds: null });
    expect(metrics[5]).toMatchObject({ unit: "currency", currency: "CNY", remaining: 0, limit: 5 });
    expect(metrics[6]).toMatchObject({ used: 0, limit: 10 });
    expect(kimiApiMetrics({ usages: { limit_5h: { used_ratio: "" }, bad: { used_ratio: -1 } } })).toEqual([]);
  });

  it("handles MiniMax counter versions, conflicting counts, boosts and explicit plan status", () => {
    const metrics = minimaxApiMetrics({ model_remains: [{ model_name: "Text", start_time: 1_900_000_000_000, end_time: 1_900_018_000_000,
      current_interval_total_count: 1000, current_interval_usage_count: 100, current_interval_remaining_percent: 90,
      current_weekly_total_count: 1000, current_weekly_usage_count: 900, current_weekly_remaining_percent: 90, weekly_boost_permille: 1500 },
    { model_name: "Conflicting", current_interval_total_count: 100, current_interval_usage_count: 40, current_interval_remaining_percent: 10 },
    { model_name: "Unlimited", current_weekly_status: 3 },
    { model_name: "Unavailable", current_interval_status: 3, current_weekly_status: 3, current_interval_total_count: 0, current_weekly_total_count: 0 }] });
    expect(metrics[0]).toMatchObject({ used: 100, remaining: 900, limit: 1000, windowSeconds: 18000 });
    expect(metrics[2]).toMatchObject({ remaining: 900 });
    expect(metrics[3]).toMatchObject({ unit: "percent", remaining: 135, used: null });
    expect(metrics.find(m => m.scope === "Conflicting" && m.unit === "units")).toMatchObject({ used: null, remaining: null, limit: 100 });
    expect(metrics.find(m => m.scope === "Unlimited")).toMatchObject({ availability: "unlimited", remaining: null });
    expect(metrics.filter(m => m.scope === "Unavailable").every(m => m.availability === "not-in-plan")).toBe(true);
    expect(() => minimaxApiMetrics({ base_resp: { status_code: 1004, status_msg: "private upstream text" } })).toThrow("reporting rejected");
    expect(minimaxApiMetrics({ available_amount: "0" })[0]).toMatchObject({ unit: "units", remaining: 0 });
  });

  it.each([
    ["https://api.kimi.com/coding/v1", "fixture-kimi", "https://api.kimi.com/coding/v1/usages"],
    ["https://api.kimi.ai/coding/v1", "fixture-global", "https://api.kimi.ai/coding/v1/usages"],
    ["https://api.minimax.io/v1", "sk-cp-fixture", "https://api.minimax.io/v1/token_plan/remains"],
    ["https://api.minimax.cn/v1", "sk-cp-cn", "https://api.minimax.cn/v1/token_plan/remains"],
    ["https://api.minimaxi.com/v1", "sk-cp-legacy", "https://api.minimaxi.com/v1/token_plan/remains"],
    ["https://api.minimax.io/v1", "sk-api-fixture", "https://api.minimax.io/account/query_balance"],
  ])("uses the configured account at %s", async (url, key, endpoint) => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${key}` });
      expect(init?.redirect).toBe("error");
      return Response.json({ usages: { limit_5h: { used_ratio: 0.25 } }, model_remains: [] });
    });
    await apiAccountUsage(url, key, fetcher)!();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(endpoint);
  });

  it("never guesses a custom gateway's reporting endpoint or follows a credential redirect", async () => {
    for (const url of ["https://api.kimi.ai.evil.invalid/coding/v1", "http://api.kimi.com/coding/v1", "https://secret@api.kimi.com/coding/v1", "https://api.minimax.io/proxy", "https://api.minimax.io/v1?forward=1"]) {
      expect(apiAccountUsage(url, "secret")).toBeUndefined();
      expect(apiReportingRoute(url)).toBeUndefined();
    }
    const fetcher = vi.fn(async () => Response.json({}, { status: 401 }));
    await expect(apiAccountUsage("https://api.kimi.ai/coding/v1", "secret", fetcher)!()).rejects.toThrow("unavailable");
    await expect(apiAccountUsage("https://api.kimi.ai/coding/v1", "", fetcher)!()).rejects.toThrow("requires");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
