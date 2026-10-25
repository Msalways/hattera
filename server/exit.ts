// Let Node drain output and pending handle cleanup before exiting. Forced
// process.exit can truncate pipes and crash older Node 24 Windows runtimes
// while fetch/worker handles are closing (nodejs/node#56645).
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
}
