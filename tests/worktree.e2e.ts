// End-to-end proof: two live Claude-powered agents running concurrently
// in separate git worktrees complete their tasks in isolation.
// Requires an authenticated Claude Code session (~/.claude/.credentials.json).
// Run from repo root:  bun tests/worktree.e2e.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HUB = "http://127.0.0.1:3003";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

function sh(cmd: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return {
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
    exitCode: p.exitCode ?? -1,
  };
}

const workDir = mkdtempSync(join(tmpdir(), "ziphub-wt-"));
const mainRepo = join(workDir, "main-repo");
const wtA = join(workDir, "wt-a");
const wtB = join(workDir, "wt-b");
const cfgPath = join(workDir, "agents.json");

// ---- set up repo + two worktrees ----
mkdirSync(mainRepo);
sh(["git", "init", "-b", "main"], mainRepo);
sh(["git", "config", "user.email", "ziphub@test"], mainRepo);
sh(["git", "config", "user.name", "ziphub"], mainRepo);
writeFileSync(join(mainRepo, "README.md"), "# test repo\n");
sh(["git", "add", "README.md"], mainRepo);
sh(["git", "commit", "-m", "init"], mainRepo);
const initSha = sh(["git", "rev-parse", "HEAD"], mainRepo).stdout.trim();
sh(["git", "worktree", "add", "-b", "branch-a", wtA], mainRepo);
sh(["git", "worktree", "add", "-b", "branch-b", wtB], mainRepo);

// re-assert identity in each worktree (shared config, but make explicit)
for (const wt of [wtA, wtB]) {
  sh(["git", "config", "user.email", "ziphub@test"], wt);
  sh(["git", "config", "user.name", "ziphub"], wt);
}

writeFileSync(
  cfgPath,
  JSON.stringify({
    agents: [
      { id: "wta", cwd: wtA, allowedTools: ["Read", "Write", "Edit", "Bash"] },
      { id: "wtb", cwd: wtB, allowedTools: ["Read", "Write", "Edit", "Bash"] },
    ],
  }),
);

// ---- start hub with supervisor ----
const hub = Bun.spawn(["bun", "packages/server/src/index.ts"], {
  env: {
    ...process.env,
    PORT: "3003",
    ZIPHUB_DB: join(workDir, "smoke.db"),
    ZIPHUB_AGENTS_CONFIG: cfgPath,
  },
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
});
const pipeLog = (stream: ReadableStream<Uint8Array> | null | undefined, tag: string) => {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        process.stderr.write(`[${tag}] ${dec.decode(value)}`);
      }
    } catch { /* ignore */ }
  })();
};
pipeLog(hub.stdout as any, "hub-out");
pipeLog(hub.stderr as any, "hub-err");

async function waitFor<T>(fn: () => Promise<T | undefined>, predicate: (v: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined && predicate(v)) return v;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function postTask(agentId: string, message: string): Promise<{ id: string }> {
  const r = await fetch(`${HUB}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId,
      message: { role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: message }] },
    }),
  });
  if (!r.ok) throw new Error(`POST /api/tasks ${r.status}: ${await r.text()}`);
  return await r.json() as { id: string };
}
async function getTask(id: string): Promise<any> {
  return await (await fetch(`${HUB}/api/tasks/${id}`)).json();
}
async function getAgents(): Promise<any[]> {
  return await (await fetch(`${HUB}/api/agents`)).json();
}

try {
  // ---- both agents must come online ----
  await waitFor(
    async () => await getAgents(),
    (list) => list.filter((a) => a.connected).length >= 2 && list.some((a) => a.id === "wta") && list.some((a) => a.id === "wtb"),
    20_000,
    "both agents connected",
  );
  check("both worktree agents registered + connected", true);

  // ---- dispatch two concurrent tasks, each agent writes a file and commits in its own worktree ----
  const promptA = `Write a file named alpha.txt (in the current working directory) with the exact content: from-a\nThen run: bash -c "git add alpha.txt && git commit -m 'from agent a'"\nStop after the commit succeeds.`;
  const promptB = `Write a file named beta.txt (in the current working directory) with the exact content: from-b\nThen run: bash -c "git add beta.txt && git commit -m 'from agent b'"\nStop after the commit succeeds.`;

  const tStart = Date.now();
  const [ta, tb] = await Promise.all([postTask("wta", promptA), postTask("wtb", promptB)]);
  console.log(`  dispatched tasks concurrently: ${ta.id.slice(0,8)} / ${tb.id.slice(0,8)}`);

  const [doneA, doneB] = await Promise.all([
    waitFor(async () => await getTask(ta.id), (t) => ["completed", "failed", "canceled"].includes(t.state), 240_000, "task A terminal"),
    waitFor(async () => await getTask(tb.id), (t) => ["completed", "failed", "canceled"].includes(t.state), 240_000, "task B terminal"),
  ]);
  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`  both terminal in ${elapsed}s — A=${doneA.state} (steps=${doneA.stepCount}, loop=${doneA.loopScore}), B=${doneB.state} (steps=${doneB.stepCount}, loop=${doneB.loopScore})`);

  check("task A completed", doneA.state === "completed", doneA.state);
  check("task B completed", doneB.state === "completed", doneB.state);

  // ---- file isolation ----
  check("wt-a has alpha.txt with 'from-a'", existsSync(join(wtA, "alpha.txt")) && readFileSync(join(wtA, "alpha.txt"), "utf8").trim() === "from-a");
  check("wt-b has beta.txt with 'from-b'", existsSync(join(wtB, "beta.txt")) && readFileSync(join(wtB, "beta.txt"), "utf8").trim() === "from-b");
  check("wt-a does NOT have beta.txt (isolation)", !existsSync(join(wtA, "beta.txt")));
  check("wt-b does NOT have alpha.txt (isolation)", !existsSync(join(wtB, "alpha.txt")));
  check("main repo untouched (no alpha/beta)", !existsSync(join(mainRepo, "alpha.txt")) && !existsSync(join(mainRepo, "beta.txt")));

  // ---- git state isolation ----
  const headA = sh(["git", "rev-parse", "HEAD"], wtA).stdout.trim();
  const headB = sh(["git", "rev-parse", "HEAD"], wtB).stdout.trim();
  const headMain = sh(["git", "rev-parse", "HEAD"], mainRepo).stdout.trim();
  check("wt-a HEAD advanced from init", headA !== initSha);
  check("wt-b HEAD advanced from init", headB !== initSha);
  check("wt-a HEAD != wt-b HEAD (different branches)", headA !== headB);
  check("main HEAD unchanged", headMain === initSha);

  const branchA = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], wtA).stdout.trim();
  const branchB = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], wtB).stdout.trim();
  check("wt-a on branch-a", branchA === "branch-a");
  check("wt-b on branch-b", branchB === "branch-b");

  const logA = sh(["git", "log", "--format=%s"], wtA).stdout.trim().split("\n");
  const logB = sh(["git", "log", "--format=%s"], wtB).stdout.trim().split("\n");
  check("wt-a log contains 'from agent a'", logA.some((l) => l.includes("from agent a")));
  check("wt-b log contains 'from agent b'", logB.some((l) => l.includes("from agent b")));

  // ---- no lingering lock files ----
  const wtList = sh(["git", "worktree", "list"], mainRepo).stdout;
  check("git worktree list shows both worktrees", wtList.includes(wtA) && wtList.includes(wtB));
  check("no lock files in wt-a", !existsSync(join(wtA, ".git", "index.lock")));
  check("no lock files in wt-b", !existsSync(join(wtB, ".git", "index.lock")));

  // ---- step events recorded per task, no crosstalk ----
  check("task A has >0 steps", doneA.stepCount > 0);
  check("task B has >0 steps", doneB.stepCount > 0);
  const aSteps = doneA.recentSteps as any[];
  const bSteps = doneB.recentSteps as any[];
  check("task A recentSteps populated", aSteps.length > 0);
  check("task B recentSteps populated", bSteps.length > 0);
  check("task A and B have distinct argsHashes in first step", (aSteps[0]?.argsHash ?? "x") !== (bSteps[0]?.argsHash ?? "y") || aSteps[0]?.at !== bSteps[0]?.at);

  // ---- both agents still connected after concurrent work ----
  const finalAgents = await getAgents();
  check("wta still connected", finalAgents.find((a) => a.id === "wta")?.connected === true);
  check("wtb still connected", finalAgents.find((a) => a.id === "wtb")?.connected === true);
} finally {
  hub.kill("SIGTERM");
  await Promise.race([hub.exited, new Promise((r) => setTimeout(r, 4000))]);
  if (hub.exitCode === null) hub.kill("SIGKILL");
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
