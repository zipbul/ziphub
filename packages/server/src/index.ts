import {
  AGENT_ID_PATTERN,
  type AgentCard,
  type AgentEvent,
  type Message,
  type Task,
} from "@zipbul/ziphub-agent-sdk/types";
import type {
  AgentCard as A2AAgentCard,
  Message as A2AMessage,
  Task as A2ATask,
} from "@a2a-js/sdk";
import { Storage, type AgentRow, type TaskRow } from "./storage.ts";
import { startSupervisor } from "./supervisor.ts";

const PEER_CALL_TIMEOUT_MS = Number(process.env.ZIPHUB_PEER_CALL_TIMEOUT_MS ?? 60_000);
type PeerWaiter = { resolve: (row: TaskRow) => void; reject: (err: Error) => void };
const peerCallWaiters = new Map<string, PeerWaiter>();

const ADMIN_TOKEN = process.env.ZIPHUB_ADMIN_TOKEN ?? "";

const storage = new Storage();
await storage.init();

function now(): string {
  return new Date().toISOString();
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function requireAdmin(req: Request): Response | null {
  if (!ADMIN_TOKEN) return null;
  if (bearer(req) !== ADMIN_TOKEN) return new Response("admin required", { status: 401 });
  return null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    agentId: row.agentId,
    fromAgentId: row.fromAgentId,
    state: row.state,
    input: row.input as Message,
    output: row.output as Message | undefined,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function logEvent(agentId: string | null, kind: string, payload: unknown): Promise<void> {
  await storage.appendEvent(agentId, kind, payload, now());
}

async function postToAgent(
  agent: AgentRow,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(`${agent.endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return res.ok || res.status === 202;
  } catch {
    return false;
  }
}

async function dispatchTask(task: Task): Promise<void> {
  const agent = await storage.getAgent(task.agentId);
  if (!agent) return;
  const ok = await postToAgent(agent, "/task", task);
  if (ok && task.state === "submitted") {
    const row = await storage.getTask(task.id);
    if (row) {
      row.state = "working";
      row.updatedAt = now();
      await storage.upsertTask(row);
    }
  } else if (!ok) {
    await logEvent(task.agentId, "task.dispatch.failed", { taskId: task.id, endpoint: agent.endpoint });
  }
}

async function recoverPending(agentId: string): Promise<void> {
  const recovered = await storage.recoverWorkingToSubmitted(agentId, now());
  if (recovered.length > 0) await logEvent(agentId, "task.recovered", { taskIds: recovered });
  for (const row of await storage.pendingTasksForAgent(agentId)) {
    await dispatchTask(rowToTask(row));
  }
}

async function createTask(input: {
  agentId: string;
  fromAgentId?: string;
  message: Message;
}): Promise<Task | null> {
  if (!(await storage.getAgent(input.agentId))) return null;
  const id = crypto.randomUUID();
  const ts = now();
  const row: TaskRow = {
    id,
    agentId: input.agentId,
    fromAgentId: input.fromAgentId,
    state: "submitted",
    input: input.message,
    createdAt: ts,
    updatedAt: ts,
  };
  await storage.upsertTask(row);
  const task = rowToTask(row);
  await logEvent(input.agentId, "task.created", { taskId: id, fromAgentId: input.fromAgentId ?? null });
  await dispatchTask(task);
  return task;
}

async function cancelTask(taskId: string): Promise<Task | null> {
  const row = await storage.getTask(taskId);
  if (!row) return null;
  const terminal = row.state === "completed" || row.state === "failed" || row.state === "canceled";
  if (terminal) return rowToTask(row);
  row.state = "canceled";
  row.updatedAt = now();
  await storage.upsertTask(row);
  const agent = await storage.getAgent(row.agentId);
  if (agent) await postToAgent(agent, "/cancel", { taskId });
  await logEvent(row.agentId, "task.canceled", { taskId });
  return rowToTask(row);
}

async function handleAgentEvent(agentId: string, event: AgentEvent): Promise<void> {
  await logEvent(agentId, event.type, event);

  if (event.type === "task.update") {
    const row = await storage.getTask(event.taskId);
    if (row && row.agentId === agentId) {
      row.state = event.state;
      row.output = event.output;
      row.error = event.error;
      row.updatedAt = now();
      await storage.upsertTask(row);

      const isTerminal =
        event.state === "completed" || event.state === "failed" || event.state === "canceled";
      if (isTerminal) {
        const waiter = peerCallWaiters.get(event.taskId);
        if (waiter) {
          peerCallWaiters.delete(event.taskId);
          waiter.resolve(row);
        }
      }
    }
  }
  // task.step / log: events 테이블에 기록만, 별도 처리 없음
}

function buildA2AAgentCard(agent: AgentRow, hubUrl: string): A2AAgentCard {
  const skills = (agent.capabilities ?? []).map((cap) => ({
    id: cap,
    name: cap,
    description: cap,
    tags: [cap],
  }));
  return {
    name: agent.name ?? agent.id,
    description: `ziphub agent ${agent.id}`,
    protocolVersion: "0.3.0",
    version: agent.version ?? "0.0.0",
    url: `${hubUrl}/a2a/${agent.id}/`,
    skills,
    capabilities: { pushNotifications: false, streaming: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}

function taskRowToA2ATask(row: TaskRow): A2ATask {
  const history: A2AMessage[] = [];
  if (row.input) history.push(row.input as A2AMessage);
  if (row.output) history.push(row.output as A2AMessage);
  return {
    kind: "task",
    id: row.id,
    contextId: row.id,
    status: {
      state: row.state,
      message: row.output as A2AMessage | undefined,
    },
    history,
  };
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

async function createPeerTask(
  toAgentId: string,
  fromAgentId: string | undefined,
  message: A2AMessage,
): Promise<TaskRow | null> {
  if (!(await storage.getAgent(toAgentId))) return null;
  const id = crypto.randomUUID();
  const ts = now();
  const row: TaskRow = {
    id,
    agentId: toAgentId,
    fromAgentId,
    state: "submitted",
    input: message,
    createdAt: ts,
    updatedAt: ts,
  };
  await storage.upsertTask(row);
  await logEvent(toAgentId, "task.created", {
    taskId: id,
    fromAgentId: fromAgentId ?? null,
    source: "peer",
  });
  return row;
}

function waitForCompletion(taskId: string, timeoutMs: number): Promise<TaskRow> {
  return new Promise((resolve, reject) => {
    const tm = setTimeout(() => {
      peerCallWaiters.delete(taskId);
      reject(new Error("peer call timeout"));
    }, timeoutMs);
    peerCallWaiters.set(taskId, {
      resolve: (row) => {
        clearTimeout(tm);
        resolve(row);
      },
      reject: (err) => {
        clearTimeout(tm);
        reject(err);
      },
    });
  });
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
        if (!AGENT_ID_PATTERN.test(card.id))
          return new Response("invalid agent id", { status: 400 });
        if (!card.endpoint || !/^https?:\/\//.test(card.endpoint))
          return new Response("endpoint required", { status: 400 });

        const ts = now();
        const existing = await storage.getAgent(card.id);
        const row: AgentRow = {
          id: card.id,
          name: card.name,
          capabilities: card.capabilities ?? [],
          version: card.version,
          endpoint: card.endpoint,
          registeredAt: existing?.registeredAt ?? ts,
          lastSeenAt: ts,
        };
        await storage.upsertAgent(row);
        await logEvent(card.id, existing ? "agent.reregistered" : "agent.registered", card);

        void recoverPending(card.id);
        return Response.json({ ok: true });
      },
    },

    "/event": {
      async POST(req) {
        const { agentId, event } = (await req.json()) as {
          agentId: string;
          event: AgentEvent;
        };
        if (!agentId || !event) return new Response("bad request", { status: 400 });
        if (!(await storage.getAgent(agentId)))
          return new Response("unknown agent", { status: 404 });
        await storage.touchAgent(agentId, now());
        await handleAgentEvent(agentId, event);
        return Response.json({ ok: true });
      },
    },

    "/api/tasks": {
      async POST(req) {
        const adminErr = requireAdmin(req);
        if (adminErr) return adminErr;
        const body = (await req.json()) as {
          agentId: string;
          fromAgentId?: string;
          message: Message;
        };
        if (!body?.agentId || !body?.message) return new Response("bad request", { status: 400 });
        const task = await createTask(body);
        if (!task) return new Response("unknown agent", { status: 404 });
        return Response.json(task);
      },
      async GET() {
        return Response.json((await storage.listTasks()).map(rowToTask));
      },
    },

    "/api/tasks/:id": {
      async GET(req) {
        const id = req.params.id;
        const row = await storage.getTask(id);
        if (!row) return new Response("unknown task", { status: 404 });
        const task = rowToTask(row);

        const { count: stepCount, recent } = await storage.taskSteps(id, 20);
        const recentSteps = recent.map((r) => {
          const step = ((r.payload as any).step ?? {}) as Record<string, unknown>;
          return { ...step, at: (step.at as string | undefined) ?? r.at };
        });

        return Response.json({
          ...task,
          lastStepAt: recentSteps[0]?.at ?? null,
          stepCount,
          connected: (await storage.getAgent(task.agentId)) !== undefined,
          recentSteps,
        });
      },
    },

    "/api/tasks/:id/cancel": {
      async POST(req) {
        const adminErr = requireAdmin(req);
        if (adminErr) return adminErr;
        const task = await cancelTask(req.params.id);
        if (!task) return new Response("unknown task", { status: 404 });
        return Response.json(task);
      },
    },

    "/api/agents": {
      async GET() {
        return Response.json(
          (await storage.listAgents()).map((r) => ({
            id: r.id,
            name: r.name,
            capabilities: r.capabilities,
            version: r.version,
            endpoint: r.endpoint,
            registeredAt: r.registeredAt,
            lastSeenAt: r.lastSeenAt,
            connected: true,
          })),
        );
      },
    },

    "/api/agents/:id": {
      async DELETE(req) {
        const agentId = req.params.id;
        const adminErr = requireAdmin(req);
        if (adminErr) return adminErr;
        const agent = await storage.getAgent(agentId);
        if (!agent) return new Response("unknown agent", { status: 404 });
        const inflight = await storage.inflightTasksForAgent(agentId);
        for (const id of inflight) await cancelTask(id);
        await postToAgent(agent, "/removed", { reason: "deregistered" });
        await storage.deleteAgent(agentId);
        await logEvent(agentId, "agent.deregistered", { canceledTaskCount: inflight.length });
        return Response.json({ ok: true, canceledTaskCount: inflight.length });
      },
    },

    "/api/events": {
      async GET() {
        return Response.json(await storage.recentEvents());
      },
    },

    "/a2a/:agentId/.well-known/agent-card.json": {
      async GET(req) {
        const agentId = req.params.agentId;
        const agent = await storage.getAgent(agentId);
        if (!agent) return new Response("unknown agent", { status: 404 });
        const hubUrl = server.url.toString().replace(/\/$/, "");
        return Response.json(buildA2AAgentCard(agent, hubUrl));
      },
    },

    "/a2a/:agentId/": {
      async POST(req) {
        const agentId = req.params.agentId;
        const target = await storage.getAgent(agentId);

        let body: { jsonrpc?: string; method?: string; params?: any; id?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonRpcError(null, -32700, "Parse error");
        }
        if (body.jsonrpc !== "2.0") {
          return jsonRpcError(body.id, -32600, "Invalid Request");
        }
        if (!target) {
          return jsonRpcError(body.id, -32601, `unknown agent: ${agentId}`);
        }
        const fromAgent = req.headers.get("x-a2a-from") ?? undefined;

        if (body.method === "message/send") {
          const message = body.params?.message as A2AMessage | undefined;
          if (!message) return jsonRpcError(body.id, -32602, "params.message required");

          const row = await createPeerTask(agentId, fromAgent, message);
          if (!row) return jsonRpcError(body.id, -32603, "task create failed");

          const completion = waitForCompletion(row.id, PEER_CALL_TIMEOUT_MS);
          await dispatchTask(rowToTask(row));
          try {
            const finalRow = await completion;
            return jsonRpcResult(body.id, taskRowToA2ATask(finalRow));
          } catch (err) {
            return jsonRpcError(
              body.id,
              -32000,
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        if (body.method === "tasks/get") {
          const taskId = body.params?.id as string | undefined;
          if (!taskId) return jsonRpcError(body.id, -32602, "params.id required");
          const row = await storage.getTask(taskId);
          if (!row) return jsonRpcError(body.id, -32601, "unknown task");
          return jsonRpcResult(body.id, taskRowToA2ATask(row));
        }

        if (body.method === "tasks/cancel") {
          const taskId = body.params?.id as string | undefined;
          if (!taskId) return jsonRpcError(body.id, -32602, "params.id required");
          const task = await cancelTask(taskId);
          if (!task) return jsonRpcError(body.id, -32601, "unknown task");
          const row = await storage.getTask(taskId);
          return jsonRpcResult(body.id, row ? taskRowToA2ATask(row) : null);
        }

        return jsonRpcError(body.id, -32601, `Method ${body.method} not implemented`);
      },
    },
  },
});

console.log(`🛰️  ziphub-server @ ${server.url}`);

const supervisor = startSupervisor({ hubUrl: server.url.toString().replace(/\/$/, "") });
if (supervisor.size() > 0) {
  console.log(`🧑‍✈️  supervising ${supervisor.size()} agent(s) from ${supervisor.configPath}`);
}

const shutdown = async (sig: string) => {
  console.log(`\n[hub] ${sig}, shutting down`);
  await supervisor.stop();
  server.stop(true);
  await storage.close();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
