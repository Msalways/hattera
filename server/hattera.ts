// Canonical entry point for the Hattera CLI. The old entry remains an alias.
import "../shared/product-compat.mjs";
import { main } from "./cli.ts";
import { exitAfterFlush } from "./exit.ts";

main().then(exitAfterFlush, (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterFlush(1);
});
