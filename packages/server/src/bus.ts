import type { HubEvent } from "@zipbul/ziphub-agent-sdk/types";

type Subscriber = (event: HubEvent) => void;

export class Bus {
  private subs = new Map<string, Set<Subscriber>>();

  subscribe(agentId: string, fn: Subscriber): () => void {
    let set = this.subs.get(agentId);
    if (!set) {
      set = new Set();
      this.subs.set(agentId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(agentId);
    };
  }

  publish(agentId: string, event: HubEvent): boolean {
    const set = this.subs.get(agentId);
    if (!set || set.size === 0) return false;
    for (const fn of set) fn(event);
    return true;
  }

  isConnected(agentId: string): boolean {
    return (this.subs.get(agentId)?.size ?? 0) > 0;
  }
}
