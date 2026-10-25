import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI shutdown", () => {
  it("drains piped output and pending cleanup with the requested exit code", async () => {
    const source = `import {exitAfterFlush} from ${JSON.stringify(new URL("./exit.ts", import.meta.url).href)};
process.stdout.write('x'.repeat(1024*1024));
setTimeout(()=>process.stderr.write('cleanup finished'),100);
exitAfterFlush(7);`;
    const result = await new Promise<{ code: number | null; out: string; err: string }>((done, fail) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", chunk => { out += String(chunk); });
      child.stderr.on("data", chunk => { err += String(chunk); });
      child.once("error", fail);
      child.once("close", code => done({ code, out, err }));
    });
    expect(result.code).toBe(7);
    expect(result.out.length).toBe(1024 * 1024);
    expect(result.err).toBe("cleanup finished");
  });
});
