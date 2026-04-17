import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentCard,
  AgentEvent,
  HubEvent,
  Message,
  Part,
  RegisterResponse,
  Task,
} from "./types.ts";

export * from "./types.ts";

export interface AgentOptions {
  id: string;
  hub?: string;
  capabilities?: string[];
  name?: string;
  version?: string;
  token?: string;
  tokenPath?: string;
}

export interface TaskContext {
  signal: AbortSignal;
}

export type TaskHandler = (
  task: Task,
  ctx: TaskContext,
) => Promise<Message | Part[] | string | void> | Message | Part[] | string | void;

export type PeerHandler = (from: string, parts: Part[], messageId: string) => void | Promise<void>;

export interface PeerUndeliverable {
  to: string;
  messageId: string;
  reason: "offline" | "unknown";
}

export type UndeliverableHandler = (info: PeerUndeliverable) => void | Promise<void>;

function defaultTokenPath(agentId: string): string {
  return join(homedir(), ".ziphub", "agents", `${agentId}.token`);
}

function loadToken(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value || undefined;
}

function saveToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
}

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
  const hub = (options.hub ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const card: AgentCard = {
    id: options.id,
    name: options.name,
    capabilities: options.capabilities ?? [],
    version: options.version,
  };
  const tokenPath = options.tokenPath ?? defaultTokenPath(options.id);
  let token: string | undefined = options.token ?? loadToken(tokenPath);

  let taskHandler: TaskHandler | undefined;
  let peerHandler: PeerHandler | undefined;
  let undeliverableHandler: UndeliverableHandler | undefined;
  let stopped = false;
  let controller: AbortController | undefined;
  const inflight = new Map<string, AbortController>();

  function authHeader(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async function post(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${hub}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
    return res;
  }

  async function sendAgentEvent(event: AgentEvent): Promise<void> {
    await post("/event", { agentId: options.id, event });
  }

  async function handleHubEvent(event: HubEvent): Promise<void> {
    if (event.type === "task.assigned") {
      const task = event.task;
      if (!taskHandler) {
        await sendAgentEvent({
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
        await sendAgentEvent({ type: "task.update", taskId: task.id, state: "working" });
        const output = toMessage(await taskHandler(task, { signal: ac.signal }));
        if (ac.signal.aborted) return;
        await sendAgentEvent({
          type: "task.update",
          taskId: task.id,
          state: "completed",
          output,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        await sendAgentEvent({
          type: "task.update",
          taskId: task.id,
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inflight.delete(task.id);
      }
    } else if (event.type === "task.canceled") {
      const ac = inflight.get(event.taskId);
      if (ac) {
        ac.abort();
        inflight.delete(event.taskId);
      }
    } else if (event.type === "peer.message") {
      await peerHandler?.(event.from, event.parts, event.messageId);
    } else if (event.type === "peer.undeliverable") {
      await undeliverableHandler?.(event);
    }
  }

  async function register(): Promise<void> {
    const res = await fetch(`${hub}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader() },
      body: JSON.stringify(card),
    });
    if (!res.ok) {
      throw new Error(
        `register ${res.status}: ${await res.text()}` +
          (res.status === 401 || res.status === 403
            ? ` (token missing or mismatch; delete ${tokenPath} and agent row to reset)`
            : ""),
      );
    }
    const body = (await res.json()) as RegisterResponse;
    if (!token && body.token) {
      saveToken(tokenPath, body.token);
      token = body.token;
    }
  }

  async function connectStream(): Promise<void> {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${hub}/stream/${encodeURIComponent(options.id)}`, {
          headers: { accept: "text/event-stream", ...authHeader() },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            try {
              const event = JSON.parse(json) as HubEvent;
              void handleHubEvent(event);
            } catch {
              /* ignore malformed */
            }
          }
        }
      } catch {
        if (stopped) return;
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return {
    card,
    onTask(handler: TaskHandler) {
      taskHandler = handler;
    },
    onPeer(handler: PeerHandler) {
      peerHandler = handler;
    },
    onPeerUndeliverable(handler: UndeliverableHandler) {
      undeliverableHandler = handler;
    },
    async emit(event: AgentEvent) {
      await sendAgentEvent(event);
    },
    async call(to: string, parts: Part[], messageId?: string): Promise<string> {
      const id = messageId ?? crypto.randomUUID();
      await sendAgentEvent({ type: "peer.send", to, messageId: id, parts });
      return id;
    },
    async start() {
      await register();
      void connectStream();
    },
    async stop() {
      stopped = true;
      controller?.abort();
      for (const ac of inflight.values()) ac.abort();
      inflight.clear();
    },
  };
}
