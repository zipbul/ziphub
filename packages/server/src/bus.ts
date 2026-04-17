import type { HubEvent } from "@zipbul/ziphub-agent-sdk/types";

export interface Subscriber {
  send: (event: HubEvent) => void;
  close: () => void;
}

export class Bus {
  private subs = new Map<string, Subscriber>();

  subscribe(agentId: string, sub: Subscriber): () => void {
    const existing = this.subs.get(agentId);
    if (existing && existing !== sub) {
      try { existing.close(); } catch { /* ignore */ }
    }
    this.subs.set(agentId, sub);
    return () => {
      if (this.subs.get(agentId) === sub) this.subs.delete(agentId);
    };
  }

  publish(agentId: string, event: HubEvent): boolean {
    const sub = this.subs.get(agentId);
    if (!sub) return false;
    try {
      sub.send(event);
      return true;
    } catch {
      this.subs.delete(agentId);
      return false;
    }
  }

  isConnected(agentId: string): boolean {
    return this.subs.has(agentId);
  }
}
