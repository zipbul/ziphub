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
}

export interface RegisterResponse {
  token: string;
}

export type HubEvent =
  | { type: "task.assigned"; task: Task }
  | { type: "task.canceled"; taskId: string }
  | {
      type: "peer.message";
      from: string;
      messageId: string;
      parts: Part[];
    }
  | {
      type: "peer.undeliverable";
      to: string;
      messageId: string;
      reason: "offline" | "unknown";
    };

export type AgentEvent =
  | {
      type: "task.update";
      taskId: string;
      state: TaskState;
      output?: Message;
      error?: string;
    }
  | {
      type: "log";
      level: "info" | "warn" | "error";
      message: string;
      data?: unknown;
    }
  | { type: "peer.send"; to: string; messageId?: string; parts: Part[] };
