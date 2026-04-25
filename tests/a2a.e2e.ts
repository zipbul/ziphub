// E2E proof: agent A calls agent B via hub-hosted A2A endpoint.
// Hub observes all peer calls (it IS the A2A server).
// Requires: ./scripts/setup-db.sh (Postgres up).
// Run from repo root: bun tests/a2a.e2e.ts

import { SQL } from "bun";
import { createAgent } from "../packages/agent-sdk/src/index.ts";
import { resetTestDb, TEST_DATABASE_URL } from "./helpers.ts";

const HUB = "http://127.0.0.1:3005";
const HUB_PORT = "3005";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

await resetTestDb();

// start hub
const hub = Bun.spawn(["bun", "packages/server/src/index.ts"], {
  env: {
    ...process.env,
    PORT: HUB_PORT,
    ZIPHUB_DATABASE_URL: TEST_DATABASE_URL,
  },
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
});
const pipeLog = (stream: ReadableStream<Uint8Array> | null | undefined, tag: string) => {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        process.stderr.write(`[${tag}] ${dec.decode(value)}`);
      }
    } catch { /* ignore */ }
  })();
};
pipeLog(hub.stdout, "hub-out");
pipeLog(hub.stderr, "hub-err");

await new Promise((r) => setTimeout(r, 1500));

// agent B: echoes what it gets, prefixed with "B:"
const agentB = createAgent({ id: "agent-b", hub: HUB, capabilities: ["echo"] });
agentB.onTask(async (task) => {
  const text = (task.input as any).parts.find((p: any) => p.kind === "text")?.text ?? "";
  return `B<-${text}`;
});

// agent A: when called, calls B with its prompt and returns "A wrapped: <B's response>"
const agentA = createAgent({ id: "agent-a", hub: HUB, capabilities: ["wrap"] });
agentA.onTask(async (task) => {
  const text = (task.input as any).parts.find((p: any) => p.kind === "text")?.text ?? "";
  // A2A peer call to B
  const bResp = await agentA.call("agent-b", [{ kind: "text", text: `from-A: ${text}` }]);
  const bText =
    (bResp?.parts.find((p: any) => p.kind === "text") as any)?.text ?? "(no response)";
  return `A wraps [${bText}]`;
});

await agentB.start();
await agentA.start();
await new Promise((r) => setTimeout(r, 500));

try {
  // smoke: both agents registered
  const agents = (await (await fetch(`${HUB}/api/agents`)).json()) as any[];
  check("agent-a registered", agents.some((a) => a.id === "agent-a"));
  check("agent-b registered", agents.some((a) => a.id === "agent-b"));

  // hub serves A2A agent card for agent-b
  const cardRes = await fetch(`${HUB}/a2a/agent-b/.well-known/agent-card.json`);
  check("agent card endpoint reachable", cardRes.ok, cardRes.status);
  const card = (await cardRes.json()) as any;
  check("card.url points to hub", card.url === `${HUB}/a2a/agent-b/`, card.url);
  check("card.protocolVersion 0.3.0", card.protocolVersion === "0.3.0");
  check("card has echo skill", card.skills?.some((s: any) => s.id === "echo"));

  // direct A2A call: send to agent-b via hub, should work
  const directReq = {
    jsonrpc: "2.0",
    id: "direct-1",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: "m-direct",
        role: "user",
        parts: [{ kind: "text", text: "ping" }],
      },
    },
  };
  const directRes = await fetch(`${HUB}/a2a/agent-b/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-a2a-from": "external" },
    body: JSON.stringify(directReq),
  });
  const directJson = (await directRes.json()) as any;
  check("direct A2A returned task", directJson.result?.kind === "task", directJson);
  check("direct A2A state completed", directJson.result?.status?.state === "completed");
  const bOut = directJson.result?.status?.message?.parts?.[0]?.text;
  check("direct A2A output 'B<-ping'", bOut === "B<-ping", bOut);

  // chained: human → A → A calls B → B responds → A wraps → returns
  const taskRes = await fetch(`${HUB}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "agent-a",
      message: {
        role: "user",
        messageId: "m-chain",
        parts: [{ kind: "text", text: "chain-me" }],
      },
    }),
  });
  const task = (await taskRes.json()) as { id: string };

  // poll for completion
  const deadline = Date.now() + 10_000;
  let final: any;
  while (Date.now() < deadline) {
    final = await (await fetch(`${HUB}/api/tasks/${task.id}`)).json();
    if (["completed", "failed", "canceled"].includes(final.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check("chained task completed", final?.state === "completed", final?.state);
  const chainOut = final?.output?.parts?.find((p: any) => p.kind === "text")?.text;
  check(
    "chained output = 'A wraps [B<-from-A: chain-me]'",
    chainOut === "A wraps [B<-from-A: chain-me]",
    chainOut,
  );

  // hub observability: events table should have all 4 task lifecycle events for both A and B
  const sql = new SQL(TEST_DATABASE_URL);
  try {
    const rows = (await sql`
      SELECT agent_id, kind, payload->>'source' as source, payload->>'taskId' as task_id
      FROM events
      WHERE kind IN ('task.created', 'task.update')
      ORDER BY id
    `) as any[];

    const aCreated = rows.filter((r) => r.agent_id === "agent-a" && r.kind === "task.created");
    const bCreated = rows.filter((r) => r.agent_id === "agent-b" && r.kind === "task.created");
    const aUpdates = rows.filter((r) => r.agent_id === "agent-a" && r.kind === "task.update");
    const bUpdates = rows.filter((r) => r.agent_id === "agent-b" && r.kind === "task.update");

    check("hub recorded agent-a task.created (chained)", aCreated.length >= 1, aCreated.length);
    check(
      "hub recorded agent-b task.created with source=peer",
      bCreated.some((r) => r.source === "peer"),
      bCreated.map((r) => r.source),
    );
    check("hub recorded agent-a task.update events (working+completed)", aUpdates.length >= 2);
    check("hub recorded agent-b task.update events", bUpdates.length >= 4); // direct + chained, each working+completed
  } finally {
    await sql.end();
  }

  // unknown method JSON-RPC error
  const unknownReq = {
    jsonrpc: "2.0",
    id: "u1",
    method: "nope/whatever",
    params: {},
  };
  const unknownRes = await fetch(`${HUB}/a2a/agent-b/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unknownReq),
  });
  const unknownJson = (await unknownRes.json()) as any;
  check("unknown JSON-RPC method returns -32601", unknownJson.error?.code === -32601);

  // unknown agent
  const unknownAgentRes = await fetch(`${HUB}/a2a/no-such/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "z", method: "message/send", params: {} }),
  });
  const unknownAgentJson = (await unknownAgentRes.json()) as any;
  check("unknown agent returns JSON-RPC error", typeof unknownAgentJson.error === "object");
} finally {
  await agentA.stop();
  await agentB.stop();
  hub.kill("SIGTERM");
  await Promise.race([hub.exited, new Promise((r) => setTimeout(r, 4000))]);
  if (hub.exitCode === null) hub.kill("SIGKILL");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
