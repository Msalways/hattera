// Keeping a test's children honest about Hattera configuration.
//
// A shell that already exports OMB_* or OPENMAUSBOT_* — an Hattera-hosted
// terminal, or a server running in another window — leaks those values into
// every child a suite spawns and into modules that snapshot process.env at
// import time. The suite then asserts against a "configured" runtime the test
// itself never set up (#1676). Strip the ambient values here; each test sets
// exactly the keys it means to set, on top of a base that carries no
// Hattera configuration at all.

const AMBIENT_PREFIXES = ["HATTERA_", "OMB_", "OPENMAUSBOT_"] as const;

/** True for canonical and legacy Hattera runtime environment keys. */
export function isAmbientOmbKey(key: string): boolean {
  return AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Copy `env` without canonical or legacy Hattera runtime settings. */
export function stripOmbEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAmbientOmbKey(key)) clean[key] = value;
  }
  return clean;
}

/**
 * Environment for a child process spawned by a test: the current environment
 * with ambient Hattera keys stripped, then `overrides` applied on top.
 *
 * The spread sits where `...process.env` used to, so a suite's own keys —
 * harness URL, tokens the stub validates, feature flags under test — are the
 * only Hattera configuration the child ever sees.
 */
export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...stripOmbEnv(process.env), ...overrides };
}
