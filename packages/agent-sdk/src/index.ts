import type { AgentCard, AgentEvent, HubEvent, Message, Part, Task } from "./types.ts";

export * from "./types.ts";

export interface AgentOptions {
  id: string;
  hub?: string;
  capabilities?: string[];
  name?: string;
  version?: string;
}

export type TaskHandler = (task: Task) => Promise<Message | Part[] | string | void> | Message | Part[] | string | void;
export type PeerHandler = (from: string, parts: Part[], messageId: string) => void | Promise<void>;

function toMessage(result: Message | Part[] | string | void): Message | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") {
    return { role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: result }] };
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

  let taskHandler: TaskHandler | undefined;
  let peerHandler: PeerHandler | undefined;
  let stopped = false;
  let controller: AbortController | undefined;

  async function post(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${hub}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
        await sendAgentEvent({ type: "task.update", taskId: task.id, state: "failed", error: "no handler" });
        return;
      }
      try {
        await sendAgentEvent({ type: "task.update", taskId: task.id, state: "working" });
        const output = toMessage(await taskHandler(task));
        await sendAgentEvent({ type: "task.update", taskId: task.id, state: "completed", output });
      } catch (err) {
        await sendAgentEvent({
          type: "task.update",
          taskId: task.id,
          state: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (event.type === "peer.message") {
      await peerHandler?.(event.from, event.parts, event.messageId);
    }
  }

  async function connectStream(): Promise<void> {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${hub}/stream/${encodeURIComponent(options.id)}`, {
          headers: { accept: "text/event-stream" },
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
              // ignore malformed
            }
          }
        }
      } catch (err) {
        if (stopped) return;
      }
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
    async emit(event: AgentEvent) {
      await sendAgentEvent(event);
    },
    async call(to: string, parts: Part[]): Promise<void> {
      await sendAgentEvent({ type: "peer.send", to, parts });
    },
    async start() {
      await post("/register", card);
      void connectStream();
    },
    async stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
