#!/usr/bin/env bun
import { runBibeAgent, type BibeAgentOptions } from "../src/bibe.ts";

function readConfig(): BibeAgentOptions {
  const raw = process.env.ZIPHUB_AGENT_CONFIG_JSON;
  if (raw) {
    const cfg = JSON.parse(raw) as Partial<BibeAgentOptions>;
    if (!cfg.id || !cfg.repoPath) {
      throw new Error("ZIPHUB_AGENT_CONFIG_JSON must include id and repoPath");
    }
    return cfg as BibeAgentOptions;
  }

  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) args.set(a.slice(2, eq), a.slice(eq + 1));
    else args.set(a.slice(2), process.argv[++i] ?? "");
  }

  const id = args.get("id") ?? process.env.ZIPHUB_AGENT_ID;
  if (!id) throw new Error("agent id required (--id or ZIPHUB_AGENT_ID)");
  const repoPath = args.get("repo") ?? process.env.ZIPHUB_AGENT_REPO ?? process.cwd();

  return {
    id,
    repoPath,
    hub: args.get("hub") ?? process.env.ZIPHUB_HUB,
    capabilities: args.get("capabilities")?.split(",").filter(Boolean),
    allowedTools: args.get("allowed-tools")?.split(",").filter(Boolean),
    systemPrompt: args.get("system-prompt"),
    model: args.get("model"),
  };
}

const cfg = readConfig();
const bibe = runBibeAgent(cfg);

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[ziphub-agent:${cfg.id}] received ${sig}, stopping`);
  try { await bibe.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

await bibe.start();
console.error(`[ziphub-agent:${cfg.id}] registered, waiting for tasks`);

// Keep event loop alive
setInterval(() => {}, 1 << 30);
