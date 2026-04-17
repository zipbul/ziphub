import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AgentConfig {
  id: string;
  cwd: string;
  capabilities?: string[];
  allowedTools?: string[];
  systemPrompt?: string;
  model?: string;
}

interface SupervisedProcess {
  config: AgentConfig;
  proc?: ReturnType<typeof Bun.spawn>;
  backoffMs: number;
  stopping: boolean;
}

const INITIAL_BACKOFF = 500;
const MAX_BACKOFF = 30_000;

function defaultConfigPath(): string {
  return process.env.ZIPHUB_AGENTS_CONFIG ?? join(homedir(), ".ziphub", "agents.json");
}

function loadConfigs(path: string): AgentConfig[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { agents?: AgentConfig[] } | AgentConfig[];
  const list = Array.isArray(parsed) ? parsed : (parsed.agents ?? []);
  for (const entry of list) {
    if (!entry.id || !entry.cwd) {
      throw new Error(`invalid agents config entry: ${JSON.stringify(entry)}`);
    }
  }
  return list;
}

export function startSupervisor(options: {
  hubUrl: string;
  configPath?: string;
  binPath?: string;
}): { stop: () => Promise<void>; size: () => number; configPath: string } {
  const configPath = options.configPath ?? defaultConfigPath();
  const binPath =
    options.binPath ??
    resolve(import.meta.dir, "../../agent-sdk/bin/agent.ts");

  let configs: AgentConfig[] = [];
  try {
    configs = loadConfigs(configPath);
  } catch (err) {
    console.error(`[supervisor] failed to load ${configPath}: ${err instanceof Error ? err.message : err}`);
    return { stop: async () => {}, size: () => 0, configPath };
  }

  if (configs.length === 0) {
    console.error(`[supervisor] no agents configured (${configPath}); running hub only`);
  }

  const procs: SupervisedProcess[] = configs.map((config) => ({
    config,
    backoffMs: INITIAL_BACKOFF,
    stopping: false,
  }));

  async function runOne(entry: SupervisedProcess): Promise<void> {
    while (!entry.stopping) {
      const env = {
        ...process.env,
        ZIPHUB_AGENT_CONFIG_JSON: JSON.stringify({
          id: entry.config.id,
          repoPath: entry.config.cwd,
          capabilities: entry.config.capabilities,
          allowedTools: entry.config.allowedTools,
          systemPrompt: entry.config.systemPrompt,
          model: entry.config.model,
          hub: options.hubUrl,
        }),
      };
      const proc = Bun.spawn(["bun", binPath], {
        cwd: entry.config.cwd,
        env,
        stdout: "inherit",
        stderr: "inherit",
      });
      entry.proc = proc;
      const code = await proc.exited;
      entry.proc = undefined;
      if (entry.stopping) return;
      console.error(
        `[supervisor] agent ${entry.config.id} exited code=${code}; restarting in ${entry.backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, entry.backoffMs));
      entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF);
    }
  }

  for (const p of procs) void runOne(p);

  let stopping = false;
  return {
    configPath,
    size: () => procs.length,
    async stop() {
      if (stopping) return;
      stopping = true;
      for (const p of procs) {
        p.stopping = true;
        p.proc?.kill("SIGTERM");
      }
      await Promise.all(
        procs.map(async (p) => {
          if (!p.proc) return;
          const timeout = new Promise<void>((resolve) =>
            setTimeout(() => {
              p.proc?.kill("SIGKILL");
              resolve();
            }, 3000),
          );
          await Promise.race([p.proc.exited.then(() => {}), timeout]);
        }),
      );
    },
  };
}
