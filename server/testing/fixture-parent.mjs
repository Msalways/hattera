// Test-only parent lifeline. An abruptly stopped test runner must not leave
// its app processes serving or writing after their fixture ownership ends.
if (process.connected) process.once("disconnect", () => {
  if (process.listenerCount("SIGTERM")) process.emit("SIGTERM");
  else process.exit(143);
});
