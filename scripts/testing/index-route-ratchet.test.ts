// The file that owns handleRequest (server/runtime.ts) may not gain request-path guards; new routes go in server/routes (see its README).
// Counted per occurrence. Each count must equal its number here, so a PR that moves a route out lowers it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROUTE_OWNER = "server/runtime.ts"; // defines handleRequest; server/index.ts only boots it
const INDEX = readFileSync(new URL(`../../${ROUTE_OWNER}`, import.meta.url), "utf8");
if (!INDEX.includes("const handleRequest = ")) throw new Error(`${ROUTE_OWNER} no longer defines handleRequest: point ROUTE_OWNER at the file that does`);

const EXACT: Record<string, number> = {
  // Internal harness routes have no server/routes module yet; moving them out is the follow-up that lowers this.
  'path === "/': 161,
  "path.match(": 88,
  "path.startsWith(": 14,
  ".exec(path)": 21,
  ".test(path)": 1,
  ".includes(path)": 4,
};

const count = (needle: string) => INDEX.split(needle).length - 1;

describe("the handleRequest file gains no route handlers", () => {
  it("matches request paths exactly as often as written here", () => {
    const changed = Object.entries(EXACT).flatMap(([needle, written]) => {
      const n = count(needle);
      if (n > written) return [`${needle} appears ${n} times, more than ${written}: put the new route in server/routes`];
      if (n < written) return [`${needle} appears ${n} times: lower its number here to ${n}`];
      return [];
    });
    expect(changed, "See server/routes/README.md").toEqual([]);
  });
});
