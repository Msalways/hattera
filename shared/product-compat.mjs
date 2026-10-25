// Compatibility boundary for installations created before the Hattera rename.
import { existsSync } from "node:fs";
import { join } from "node:path";

export function withLegacyEnvironment(environment) {
  const next = { ...environment };
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith("HATTERA_") && value !== undefined) next[`OMB_${key.slice(8)}`] = value;
  }
  return next;
}

export function defaultDataDirectory(home, exists = existsSync) {
  const legacy = join(home, ".openmausbot");
  return exists(legacy) ? legacy : join(home, ".hattera");
}

export function applyEnvironmentAliases(environment) {
  Object.assign(environment, withLegacyEnvironment(environment));
  // Consume launch aliases once. Internal child launches may deliberately
  // override a workspace, port or trust flag; stale aliases must not undo it
  // when that child bootstraps (especially an explicit --data-dir).
  for (const key of Object.keys(environment)) if (key.startsWith("HATTERA_")) delete environment[key];
  return environment;
}

// Load before modules that read legacy environment names at module scope.
applyEnvironmentAliases(process.env);
export default { withLegacyEnvironment, defaultDataDirectory };
