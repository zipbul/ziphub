import type { AgentCard, AgentEvent, HubEvent, Message, Task, TaskState } from "@zipbul/ziphub-agent-sdk/types";
import { openDb } from "./db.ts";
import { Bus } from "./bus.ts";

const db = openDb();
const bus = new Bus();

function now(): string {
  return new Date().toISOString();
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    agentId: row.agent_id,
    fromAgentId: row.from_agent_id ?? undefined,
    state: row.state as TaskState,
    input: JSON.parse(row.input) as Message,
    output: row.output ? (JSON.parse(row.output) as Message) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function logEvent(agentId: string | null, kind: string, payload: unknown): void {
  db.query("INSERT INTO events (agent_id, kind, payload, created_at) VALUES (?, ?, ?, ?)").run(
    agentId,
    kind,
    JSON.stringify(payload),
    now(),
  );
}

function dispatchTask(task: Task): void {
  const event: HubEvent = { type: "task.assigned", task };
  const delivered = bus.publish(task.agentId, event);
  if (delivered && task.state === "submitted") {
    db.query("UPDATE tasks SET state = 'working', updated_at = ? WHERE id = ?").run(now(), task.id);
  }
}

function flushPending(agentId: string): void {
  const rows = db.query("SELECT * FROM tasks WHERE agent_id = ? AND state = 'submitted' ORDER BY created_at").all(agentId) as any[];
  for (const row of rows) dispatchTask(rowToTask(row));
}

function createTask(input: {
  agentId: string;
  fromAgentId?: string;
  message: Message;
}): Task {
  const id = crypto.randomUUID();
  const ts = now();
  db.query(
    "INSERT INTO tasks (id, agent_id, from_agent_id, state, input, created_at, updated_at) VALUES (?, ?, ?, 'submitted', ?, ?, ?)",
  ).run(id, input.agentId, input.fromAgentId ?? null, JSON.stringify(input.message), ts, ts);
  const task: Task = {
    id,
    agentId: input.agentId,
    fromAgentId: input.fromAgentId,
    state: "submitted",
    input: input.message,
    createdAt: ts,
    updatedAt: ts,
  };
  logEvent(input.agentId, "task.created", { taskId: id, fromAgentId: input.fromAgentId ?? null });
  dispatchTask(task);
  return task;
}

function handleAgentEvent(agentId: string, event: AgentEvent): void {
  logEvent(agentId, event.type, event);

  if (event.type === "task.update") {
    db.query("UPDATE tasks SET state = ?, output = ?, error = ?, updated_at = ? WHERE id = ? AND agent_id = ?").run(
      event.state,
      event.output ? JSON.stringify(event.output) : null,
      event.error ?? null,
      now(),
      event.taskId,
      agentId,
    );
  } else if (event.type === "peer.send") {
    bus.publish(event.to, {
      type: "peer.message",
      from: agentId,
      messageId: crypto.randomUUID(),
      parts: event.parts,
    });
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/api/health": {
      GET() {
        return Response.json({ status: "ok", ts: now() });
      },
    },

    "/register": {
      async POST(req) {
        const card = (await req.json()) as AgentCard;
        const ts = now();
        db.query(
          `INSERT INTO agents (id, name, capabilities, version, registered_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name,
             capabilities=excluded.capabilities,
             version=excluded.version,
             last_seen_at=excluded.last_seen_at`,
        ).run(card.id, card.name ?? null, JSON.stringify(card.capabilities ?? []), card.version ?? null, ts, ts);
        logEvent(card.id, "agent.registered", card);
        return Response.json({ ok: true });
      },
    },

    "/event": {
      async POST(req) {
        const { agentId, event } = (await req.json()) as { agentId: string; event: AgentEvent };
        if (!agentId || !event) return new Response("bad request", { status: 400 });
        db.query("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now(), agentId);
        handleAgentEvent(agentId, event);
        return Response.json({ ok: true });
      },
    },

    "/stream/:agentId": {
      GET(req) {
        const agentId = req.params.agentId;
        const exists = db.query("SELECT 1 FROM agents WHERE id = ?").get(agentId);
        if (!exists) return new Response("unknown agent", { status: 404 });

        const stream = new ReadableStream({
          start(ctrl) {
            const encoder = new TextEncoder();
            const send = (event: HubEvent) => {
              try {
                ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {
                /* connection closed */
              }
            };
            const unsub = bus.subscribe(agentId, send);
            ctrl.enqueue(encoder.encode(`: connected\n\n`));
            const heartbeat = setInterval(() => {
              try {
                ctrl.enqueue(encoder.encode(`: ping\n\n`));
              } catch {
                /* ignored */
              }
            }, 15000);

            flushPending(agentId);

            req.signal.addEventListener("abort", () => {
              clearInterval(heartbeat);
              unsub();
              try { ctrl.close(); } catch {}
            });
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      },
    },

    "/api/tasks": {
      async POST(req) {
        const body = (await req.json()) as { agentId: string; fromAgentId?: string; message: Message };
        if (!body?.agentId || !body?.message) return new Response("bad request", { status: 400 });
        const task = createTask(body);
        return Response.json(task);
      },
      GET() {
        const rows = db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200").all() as any[];
        return Response.json(rows.map(rowToTask));
      },
    },

    "/api/agents": {
      GET() {
        const rows = db.query("SELECT * FROM agents ORDER BY id").all() as any[];
        return Response.json(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            capabilities: JSON.parse(r.capabilities),
            version: r.version,
            registeredAt: r.registered_at,
            lastSeenAt: r.last_seen_at,
            connected: bus.isConnected(r.id),
          })),
        );
      },
    },

    "/api/events": {
      GET() {
        const rows = db.query("SELECT * FROM events ORDER BY id DESC LIMIT 200").all() as any[];
        return Response.json(
          rows.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            kind: r.kind,
            payload: JSON.parse(r.payload),
            createdAt: r.created_at,
          })),
        );
      },
    },
  },
});

console.log(`🛰️  ziphub-server @ ${server.url}`);
