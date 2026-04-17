import { query, type HookCallback, type HookInput, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgent, type AgentOptions } from "./index.ts";
import type { Message, TaskStep } from "./types.ts";

export interface BibeAgentOptions extends Omit<AgentOptions, "capabilities"> {
  repoPath: string;
  capabilities?: string[];
  allowedTools?: string[];
  systemPrompt?: string;
  model?: string;
  maxStepPayloadBytes?: number;
}

const FORWARDED_HOOKS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
] as const;

export function runBibeAgent(options: BibeAgentOptions) {
  const agent = createAgent({
    id: options.id,
    hub: options.hub,
    name: options.name,
    version: options.version,
    token: options.token,
    tokenPath: options.tokenPath,
    capabilities: options.capabilities ?? ["bibecoding"],
  });

  const allowedTools = options.allowedTools ?? ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
  const maxBytes = options.maxStepPayloadBytes ?? 8192;

  let activeQuery: Query | undefined;

  agent.onTask(async (task, ctx) => {
    const prompt = extractPrompt(task.input);

    const hooks: Record<string, { hooks: HookCallback[] }[]> = {};
    for (const name of FORWARDED_HOOKS) {
      hooks[name] = [{ hooks: [buildHookCallback(agent, task.id, name, maxBytes)] }];
    }

    const stream = makePromptStream(prompt);
    const q = query({
      prompt: stream,
      options: {
        cwd: options.repoPath,
        allowedTools,
        permissionMode: "bypassPermissions",
        persistSession: false,
        ...(options.model ? { model: options.model } : {}),
        ...(options.systemPrompt ? { customSystemPrompt: options.systemPrompt } : {}),
        hooks,
      },
    });
    activeQuery = q;

    const onAbort = () => {
      void q.interrupt().catch(() => { /* ignore */ });
    };
    ctx.signal.addEventListener("abort", onAbort);

    let finalText = "";
    try {
      for await (const msg of q) {
        if (ctx.signal.aborted) break;
        if (msg.type === "result" && "result" in msg && typeof msg.result === "string") {
          finalText = msg.result;
        }
      }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      activeQuery = undefined;
    }

    return finalText || "completed";
  });

  agent.onStop(() => {
    void activeQuery?.interrupt().catch(() => { /* ignore */ });
  });

  return {
    agent,
    start: () => agent.start(),
    stop: () => agent.stop(),
  };
}

function extractPrompt(msg: Message): string {
  const texts: string[] = [];
  for (const part of msg.parts) {
    if (part.kind === "text") texts.push(part.text);
    else if (part.kind === "data") texts.push("```json\n" + JSON.stringify(part.data, null, 2) + "\n```");
  }
  return texts.join("\n\n") || "(empty prompt)";
}

async function* makePromptStream(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k])).join(",") + "}";
}

async function sha256Hex12(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 6; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function truncStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.floor(max)) + "…[truncated]" : s;
}

function truncatePayload(
  payload: Record<string, unknown>,
  maxBytes: number,
): { payload: Record<string, unknown>; truncated: boolean } {
  const originalSize = JSON.stringify(payload).length;
  if (originalSize <= maxBytes) return { payload, truncated: false };

  const out: Record<string, unknown> = { ...payload };
  if (typeof out.tool_response === "string") {
    out.tool_response = truncStr(out.tool_response as string, maxBytes / 2);
  }
  if (out.tool_input && typeof out.tool_input === "object") {
    const ti: Record<string, unknown> = { ...(out.tool_input as Record<string, unknown>) };
    for (const k of Object.keys(ti)) {
      const v = ti[k];
      if (typeof v === "string") ti[k] = truncStr(v, maxBytes / 4);
    }
    out.tool_input = ti;
  }
  if (typeof out.prompt === "string") {
    out.prompt = truncStr(out.prompt as string, maxBytes / 2);
  }
  if (typeof out.message === "string") {
    out.message = truncStr(out.message as string, maxBytes / 2);
  }

  if (JSON.stringify(out).length > maxBytes) {
    return {
      payload: {
        omitted: "too_large",
        originalSize,
        hook_event_name: out.hook_event_name,
        tool_name: out.tool_name,
      },
      truncated: true,
    };
  }
  return { payload: out, truncated: true };
}

function buildHookCallback(
  agent: ReturnType<typeof createAgent>,
  taskId: string,
  kind: string,
  maxBytes: number,
): HookCallback {
  return async (input: HookInput) => {
    void (async () => {
      const raw = input as unknown as Record<string, unknown>;
      const toolInput = raw.tool_input;
      const argsHash =
        toolInput !== undefined ? await sha256Hex12(canonicalize(toolInput)) : undefined;
      const { payload, truncated } = truncatePayload(raw, maxBytes);
      const step: TaskStep = {
        kind,
        toolName: typeof raw.tool_name === "string" ? raw.tool_name : undefined,
        argsHash,
        payload,
        truncated,
        at: new Date().toISOString(),
      };
      try {
        await agent.emit({ type: "task.step", taskId, step });
      } catch {
        /* ignore hub errors; don't block the hook */
      }
    })();
    return { continue: true };
  };
}
