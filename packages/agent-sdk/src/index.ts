import {
  AGENT_ID_PATTERN,
  type AgentCard,
  type AgentEvent,
  type Message,
  type Part,
  type Task,
} from "./types.ts";

export * from "./types.ts";

export interface AgentOptions {
  id: string;
  hub?: string;
  capabilities?: string[];
  name?: string;
  version?: string;
  hostname?: string;
  port?: number;
}

export interface TaskContext {
  signal: AbortSignal;
}

export type TaskHandler = (
  task: Task,
  ctx: TaskContext,
) => Promise<Message | Part[] | string | void> | Message | Part[] | string | void;

export type StopReason = "deregistered" | "error";

function toMessage(result: Message | Part[] | string | void): Message | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") {
    return {
      role: "agent",
      messageId: crypto.randomUUID(),
      parts: [{ kind: "text", text: result }],
    };
  }
  if (Array.isArray(result)) {
    return { role: "agent", messageId: crypto.randomUUID(), parts: result };
  }
  return result;
}

export function createAgent(options: AgentOptions) {
  if (!AGENT_ID_PATTERN.test(options.id)) {
    throw new Error(`invalid agent id ${JSON.stringify(options.id)}; must match ${AGENT_ID_PATTERN}`);
  }
  const hub = (options.hub ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const hostname = options.hostname ?? "127.0.0.1";

  let taskHandler: TaskHandler | undefined;
  let stopHandler: ((reason: StopReason, detail?: string) => void | Promise<void>) | undefined;
  let stopped = false;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const inflight = new Map<string, AbortController>();

  async function sendEvent(event: AgentEvent): Promise<void> {
    try {
      const res = await fetch(`${hub}/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: options.id, event }),
      });
      if (!res.ok) {
        // hub가 우리를 모름 (deregistered 이후) → 자체 종료
        if (res.status === 404) {
          stopped = true;
          await stopHandler?.("deregistered");
        }
      }
    } catch {
      // hub down — 일단 무시 (Step 2에서 큐잉)
    }
  }

  async function runTask(task: Task): Promise<void> {
    if (!taskHandler) {
      await sendEvent({
        type: "task.update",
        taskId: task.id,
        state: "failed",
        error: "no handler",
      });
      return;
    }
    const ac = new AbortController();
    inflight.set(task.id, ac);
    try {
      await sendEvent({ type: "task.update", taskId: task.id, state: "working" });
      const out = toMessage(await taskHandler(task, { signal: ac.signal }));
      if (ac.signal.aborted) return;
      await sendEvent({
        type: "task.update",
        taskId: task.id,
        state: "completed",
        output: out,
      });
    } catch (err) {
      if (ac.signal.aborted) return;
      await sendEvent({
        type: "task.update",
        taskId: task.id,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflight.delete(task.id);
    }
  }

  function startListener(): { endpoint: string } {
    server = Bun.serve({
      hostname,
      port: options.port ?? 0,
      routes: {
        "/health": {
          GET() {
            return Response.json({ ok: true });
          },
        },
        "/task": {
          async POST(req) {
            const task = (await req.json()) as Task;
            // 처리는 비동기로, 즉시 202
            void runTask(task);
            return new Response(null, { status: 202 });
          },
        },
        "/cancel": {
          async POST(req) {
            const { taskId } = (await req.json()) as { taskId: string };
            const ac = inflight.get(taskId);
            if (ac) {
              ac.abort();
              inflight.delete(taskId);
            }
            return Response.json({ ok: true });
          },
        },
        "/removed": {
          async POST() {
            stopped = true;
            for (const ac of inflight.values()) ac.abort();
            inflight.clear();
            await stopHandler?.("deregistered");
            // server는 stop()에서 닫음
            return Response.json({ ok: true });
          },
        },
      },
    });
    const port = (server as { port?: number }).port;
    if (typeof port !== "number") {
      throw new Error("agent listener failed to bind a port");
    }
    return { endpoint: `http://${hostname}:${port}` };
  }

  async function register(endpoint: string): Promise<void> {
    const card: AgentCard = {
      id: options.id,
      name: options.name,
      capabilities: options.capabilities ?? [],
      version: options.version,
      endpoint,
    };
    const res = await fetch(`${hub}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!res.ok) {
      throw new Error(`register ${res.status}: ${await res.text()}`);
    }
  }

  async function call(to: string, parts: Part[]): Promise<Message | undefined> {
    const messageId = crypto.randomUUID();
    const reqBody = {
      jsonrpc: "2.0",
      id: messageId,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId,
          role: "agent",
          parts,
        },
      },
    };
    const res = await fetch(`${hub}/a2a/${encodeURIComponent(to)}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-from": options.id,
      },
      body: JSON.stringify(reqBody),
    });
    if (!res.ok) {
      throw new Error(`a2a ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      result?: { kind?: string; status?: { message?: Message }; output?: Message };
      error?: { code: number; message: string };
    };
    if (json.error) throw new Error(`a2a error ${json.error.code}: ${json.error.message}`);
    const result = json.result;
    if (!result) return undefined;
    if (result.kind === "task") return result.status?.message ?? undefined;
    if (result.kind === "message") return result as unknown as Message;
    return undefined;
  }

  return {
    get card(): AgentCard {
      return {
        id: options.id,
        name: options.name,
        capabilities: options.capabilities ?? [],
        version: options.version,
        endpoint: server ? `http://${hostname}:${(server as { port?: number }).port}` : "",
      };
    },
    onTask(handler: TaskHandler) {
      taskHandler = handler;
    },
    onStop(handler: (reason: StopReason, detail?: string) => void | Promise<void>) {
      stopHandler = handler;
    },
    async emit(event: AgentEvent) {
      await sendEvent(event);
    },
    call,
    async start() {
      const { endpoint } = startListener();
      await register(endpoint);
    },
    async stop() {
      stopped = true;
      for (const ac of inflight.values()) ac.abort();
      inflight.clear();
      server?.stop(true);
    },
  };
}
