import type {
  AgentCard,
  AgentEvent,
  HubEvent,
  Message,
  Task,
  TaskState,
} from "@zipbul/ziphub-agent-sdk/types";
import { openDb } from "./db.ts";
import { Bus } from "./bus.ts";

const EVENT_RETENTION = Number(process.env.ZIPHUB_EVENT_RETENTION ?? 10000);

const db = openDb();
const bus = new Bus();

function now(): string {
  return new Date().toISOString();
}

function newToken(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(buf).toString("hex");
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function requireAgent(req: Request, agentId: string): Promise<Response | null> {
  const token = bearer(req);
  if (!token) return new Response("unauthorized", { status: 401 });
  const row = db.query("SELECT token_hash FROM agents WHERE id = ?").get(agentId) as
    | { token_hash: string }
    | undefined;
  if (!row) return new Response("unknown agent", { status: 404 });
  const hash = await hashToken(token);
  if (hash !== row.token_hash) return new Response("forbidden", { status: 403 });
  return null;
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
  if (EVENT_RETENTION > 0) {
    db.query(
      `DELETE FROM events WHERE id IN (
         SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?
       )`,
    ).run(EVENT_RETENTION);
  }
}

function dispatchTask(task: Task): void {
  const delivered = bus.publish(task.agentId, { type: "task.assigned", task });
  if (delivered && task.state === "submitted") {
    db.query("UPDATE tasks SET state = 'working', updated_at = ? WHERE id = ?").run(now(), task.id);
  }
}

function recoverWorkingTasks(agentId: string): void {
  const changed = db
    .query(
      "UPDATE tasks SET state = 'submitted', updated_at = ? WHERE agent_id = ? AND state = 'working' RETURNING id",
    )
    .all(now(), agentId) as { id: string }[];
  if (changed.length > 0) {
    logEvent(agentId, "task.recovered", { taskIds: changed.map((r) => r.id) });
  }
}

function flushPending(agentId: string): void {
  const rows = db
    .query("SELECT * FROM tasks WHERE agent_id = ? AND state = 'submitted' ORDER BY created_at")
    .all(agentId) as any[];
  for (const row of rows) dispatchTask(rowToTask(row));
}

function createTask(input: {
  agentId: string;
  fromAgentId?: string;
  message: Message;
}): Task | null {
  const agentExists = db.query("SELECT 1 FROM agents WHERE id = ?").get(input.agentId);
  if (!agentExists) return null;
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

function cancelTask(taskId: string): Task | null {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!row) return null;
  const terminal = row.state === "completed" || row.state === "failed" || row.state === "canceled";
  if (terminal) return rowToTask(row);
  db.query("UPDATE tasks SET state = 'canceled', updated_at = ? WHERE id = ?").run(now(), taskId);
  bus.publish(row.agent_id, { type: "task.canceled", taskId });
  logEvent(row.agent_id, "task.canceled", { taskId });
  return rowToTask({ ...row, state: "canceled", updated_at: now() });
}

function handleAgentEvent(agentId: string, event: AgentEvent): void {
  logEvent(agentId, event.type, event);

  if (event.type === "task.update") {
    db.query(
      "UPDATE tasks SET state = ?, output = ?, error = ?, updated_at = ? WHERE id = ? AND agent_id = ?",
    ).run(
      event.state,
      event.output ? JSON.stringify(event.output) : null,
      event.error ?? null,
      now(),
      event.taskId,
      agentId,
    );
  } else if (event.type === "peer.send") {
    const targetExists = db.query("SELECT 1 FROM agents WHERE id = ?").get(event.to);
    const messageId = event.messageId ?? crypto.randomUUID();
    if (!targetExists) {
      bus.publish(agentId, { type: "peer.undeliverable", to: event.to, messageId, reason: "unknown" });
      logEvent(agentId, "peer.undeliverable", { to: event.to, messageId, reason: "unknown" });
      return;
    }
    const delivered = bus.publish(event.to, {
      type: "peer.message",
      from: agentId,
      messageId,
      parts: event.parts,
    });
    if (!delivered) {
      bus.publish(agentId, { type: "peer.undeliverable", to: event.to, messageId, reason: "offline" });
      logEvent(agentId, "peer.undeliverable", { to: event.to, messageId, reason: "offline" });
    }
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
        if (!card?.id) return new Response("bad request", { status: 400 });
        const ts = now();
        const existing = db.query("SELECT token_hash FROM agents WHERE id = ?").get(card.id) as
          | { token_hash: string }
          | undefined;

        if (existing) {
          const presented = bearer(req);
          if (!presented) return new Response("unauthorized", { status: 401 });
          if ((await hashToken(presented)) !== existing.token_hash)
            return new Response("forbidden", { status: 403 });
          db.query(
            "UPDATE agents SET name = ?, capabilities = ?, version = ?, last_seen_at = ? WHERE id = ?",
          ).run(
            card.name ?? null,
            JSON.stringify(card.capabilities ?? []),
            card.version ?? null,
            ts,
            card.id,
          );
          logEvent(card.id, "agent.reregistered", card);
          return Response.json({ token: presented });
        }

        const token = newToken();
        const hash = await hashToken(token);
        db.query(
          `INSERT INTO agents (id, name, capabilities, version, token_hash, registered_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          card.id,
          card.name ?? null,
          JSON.stringify(card.capabilities ?? []),
          card.version ?? null,
          hash,
          ts,
          ts,
        );
        logEvent(card.id, "agent.registered", card);
        return Response.json({ token });
      },
    },

    "/event": {
      async POST(req) {
        const { agentId, event } = (await req.json()) as {
          agentId: string;
          event: AgentEvent;
        };
        if (!agentId || !event) return new Response("bad request", { status: 400 });
        const authErr = await requireAgent(req, agentId);
        if (authErr) return authErr;
        db.query("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now(), agentId);
        handleAgentEvent(agentId, event);
        return Response.json({ ok: true });
      },
    },

    "/stream/:agentId": {
      async GET(req) {
        const agentId = req.params.agentId;
        const authErr = await requireAgent(req, agentId);
        if (authErr) return authErr;

        const stream = new ReadableStream({
          start(ctrl) {
            const encoder = new TextEncoder();
            let closed = false;
            const subscriber = {
              send: (event: HubEvent) => {
                if (closed) return;
                ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              },
              close: () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                try { ctrl.close(); } catch { /* ignore */ }
              },
            };

            const unsub = bus.subscribe(agentId, subscriber);
            ctrl.enqueue(encoder.encode(`: connected\n\n`));
            const heartbeat = setInterval(() => {
              if (closed) return;
              try { ctrl.enqueue(encoder.encode(`: ping\n\n`)); } catch { /* ignore */ }
            }, 15000);

            logEvent(agentId, "agent.online", {});
            recoverWorkingTasks(agentId);
            flushPending(agentId);

            const onAbort = () => {
              subscriber.close();
              unsub();
              logEvent(agentId, "agent.offline", {});
            };
            req.signal.addEventListener("abort", onAbort);
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
        const body = (await req.json()) as {
          agentId: string;
          fromAgentId?: string;
          message: Message;
        };
        if (!body?.agentId || !body?.message) return new Response("bad request", { status: 400 });
        const task = createTask(body);
        if (!task) return new Response("unknown agent", { status: 404 });
        return Response.json(task);
      },
      GET() {
        const rows = db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200").all() as any[];
        return Response.json(rows.map(rowToTask));
      },
    },

    "/api/tasks/:id/cancel": {
      POST(req) {
        const task = cancelTask(req.params.id);
        if (!task) return new Response("unknown task", { status: 404 });
        return Response.json(task);
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

    "/api/agents/:id": {
      async DELETE(req) {
        const agentId = req.params.id;
        const authErr = await requireAgent(req, agentId);
        if (authErr) return authErr;
        const inflight = db
          .query("SELECT id FROM tasks WHERE agent_id = ? AND state IN ('submitted','working')")
          .all(agentId) as { id: string }[];
        for (const row of inflight) cancelTask(row.id);
        const existing = bus.isConnected(agentId);
        if (existing) {
          bus.publish(agentId, { type: "task.canceled", taskId: "__deregister__" });
        }
        db.query("DELETE FROM agents WHERE id = ?").run(agentId);
        logEvent(agentId, "agent.deregistered", { canceledTaskCount: inflight.length });
        return Response.json({ ok: true, canceledTaskCount: inflight.length });
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
