/** The key that lets a test process mint an internal capability through
 * `/api/testing/internal-capability`. It is honoured only when the launcher
 * also states, explicitly, that this server runs under the test harness
 * (`OMB_TEST_HARNESS=1`). Anywhere else the key is ignored, so a stray
 * variable in a real environment cannot open the route. */
export const TEST_HARNESS_FLAG = "OMB_TEST_HARNESS";
export const TEST_CAPABILITY_KEY_VAR = "OMB_TEST_INTERNAL_CAPABILITY_KEY";

export function testCapabilityKey(env: NodeJS.ProcessEnv = process.env): string {
  return env[TEST_HARNESS_FLAG] === "1" ? (env[TEST_CAPABILITY_KEY_VAR] ?? "") : "";
}

/** One startup warning when the key is set but ignored. Returns whether it warned. */
export function warnIfTestCapabilityKeyIgnored(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = console.warn): boolean {
  if (!env[TEST_CAPABILITY_KEY_VAR] || env[TEST_HARNESS_FLAG] === "1") return false;
  warn(`${TEST_CAPABILITY_KEY_VAR} is set but ignored: it only works when ${TEST_HARNESS_FLAG}=1 marks a test-harness server`);
  return true;
}
