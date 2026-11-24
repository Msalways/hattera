import { describe, expect, it, vi } from "vitest";
import { testCapabilityKey, warnIfTestCapabilityKeyIgnored } from "./test-capability-key.ts";

describe("test capability key guard", () => {
  it("honours the key when the server runs under the test harness", () => {
    const env = { OMB_TEST_HARNESS: "1", OMB_TEST_INTERNAL_CAPABILITY_KEY: "k".repeat(32) };
    const warn = vi.fn();
    expect(testCapabilityKey(env)).toBe("k".repeat(32));
    expect(warnIfTestCapabilityKeyIgnored(env, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores the key outside the test harness and warns once", () => {
    const warn = vi.fn();
    for (const env of [
      { OMB_TEST_INTERNAL_CAPABILITY_KEY: "k".repeat(32) },
      { OMB_TEST_HARNESS: "0", OMB_TEST_INTERNAL_CAPABILITY_KEY: "k".repeat(32) },
      { OMB_TEST_HARNESS: "true", OMB_TEST_INTERNAL_CAPABILITY_KEY: "k".repeat(32) },
    ]) {
      expect(testCapabilityKey(env)).toBe("");
      expect(warnIfTestCapabilityKeyIgnored(env, warn)).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]![0]).toContain("ignored");
    expect(warn.mock.calls[0]![0]).not.toContain("kkkk");
  });

  it("is silent and empty when no key is set", () => {
    const warn = vi.fn();
    expect(testCapabilityKey({})).toBe("");
    expect(testCapabilityKey({ OMB_TEST_HARNESS: "1" })).toBe("");
    expect(warnIfTestCapabilityKeyIgnored({}, warn)).toBe(false);
  });
});
