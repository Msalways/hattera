#!/usr/bin/env -S node --experimental-strip-types
// Disposable three-bot demo. The scripted engine proves orchestration without
// using a provider account; replace it with a signed-in engine for live work.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { request } from "./mcp-server.ts";

const launch = () => launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
const session = await launch().catch(error => {
  // A cold Windows install can exceed the fixture's 20-second startup limit.
  if (!String(error).includes("did not become ready")) throw error;
  return launch();
});
const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
const api = (path: string, body?: unknown, method = "POST") => request(path,
  body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;

try {
  const chief = (await cli("new-bot", "--name", "Chief", "--section", "Leadership")).bot;
  const lead = (await cli("new-bot", "--name", "Builder", "--section", "Engineering")).bot;
  const reviewer = (await cli("new-bot", "--name", "Reviewer", "--section", "Engineering")).bot;
  await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");

  const planPath = join(session.info.dataDir, "room-plan.json");
  writeFileSync(planPath, JSON.stringify({
    [chief.id]: {
      steps: [{ arguments: { bot_ids: [lead.id], message: "Propose a CSV export design and ask Reviewer to check one edge case." } }],
      reply: "Sent to Builder",
      resumeReply: "Builder proposed a CSV export design and Reviewer checked an edge case.",
    },
    [lead.id]: {
      steps: [{ arguments: { bot_ids: [reviewer.id], message: "Check the CSV export design for empty values." } }],
      reply: "Sent to Reviewer",
      resumeReply: "CSV export design drafted; Reviewer checked the empty-value case.",
    },
    [reviewer.id]: { reply: "CSV export design review complete, including empty values." },
  }));

  await cli("send", "--bot", chief.id, "--task", chief.activeTaskId,
    "--text", "Have Builder propose a CSV export design and Reviewer check one edge case. Report the result.");
  const outcome = await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "60");
  const evidence = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const messages = (await api(`/api/threads/${chief.activeTaskId}/messages`)).messages as Array<{ text?: string }>;
  const expected = [chief.id, lead.id, reviewer.id, lead.id, chief.id];
  if (outcome.status !== "settled" || evidence.length !== expected.length
    || evidence.some((turn, index) => turn.botId !== expected[index])
    || !messages.some(message => message.text === "Builder proposed a CSV export design and Reviewer checked an edge case.")) {
    throw new Error("The three-bot handoff did not finish as expected; inspect the retained server log.");
  }

  console.log(JSON.stringify({
    ok: true,
    server: session.info.url,
    log: session.info.logPath,
    bots: [chief.name, lead.name, reviewer.name],
    turnOrder: ["Chief", "Builder", "Reviewer", "Builder", "Chief"],
    finalAnswer: "Builder proposed a CSV export design and Reviewer checked an edge case.",
    engine: "scripted fixture",
  }, null, 2));
  if (!process.argv.includes("--once")) {
    console.log("Server stays available until Ctrl+C. This demo uses disposable data.");
    await new Promise<void>(resolve => process.once("SIGINT", resolve));
  }
} finally {
  await session.close();
}
