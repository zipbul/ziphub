export type TaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled";

export type Part =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown }
  | { kind: "file"; name: string; mimeType?: string; bytes?: string; uri?: string };

export interface Message {
  role: "user" | "agent";
  parts: Part[];
  messageId: string;
}

export interface Task {
  id: string;
  state: TaskState;
  agentId: string;
  fromAgentId?: string;
  input: Message;
  output?: Message;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentCard {
  id: string;
  name?: string;
  capabilities: string[];
  version?: string;
  endpoint: string;
}

export const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface TaskStep {
  kind: string;
  toolName?: string;
  argsHash?: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  at: string;
}

export type AgentEvent =
  | {
      type: "task.update";
      taskId: string;
      state: TaskState;
      output?: Message;
      error?: string;
    }
  | { type: "task.step"; taskId: string; step: TaskStep }
  | {
      type: "log";
      level: "info" | "warn" | "error";
      message: string;
      data?: unknown;
    };
