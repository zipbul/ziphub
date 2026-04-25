// Proof: supervisor pauses (instead of respawn-looping) when an agent's cwd
// is missing, and resumes when the cwd reappears.
// Run from repo root:  bun tests/supervisor-missing-cwd.e2e.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTestDb, TEST_DATABASE_URL } from "./helpers.ts";

const HUB = "http://127.0.0.1:3004";

await resetTestDb();

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
}

const workDir = mkdtempSync(join(tmpdir(), "ziphub-mc-"));
const ghostCwd = join(workDir, "does-not-exist");
const cfgPath = join(workDir, "agents.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    agents: [{ id: "ghost", cwd: ghostCwd }],
  }),
);

const hub = Bun.spawn(["bun", "packages/server/src/index.ts"], {
  env: {
    ...process.env,
    PORT: "3004",
    ZIPHUB_DATABASE_URL: TEST_DATABASE_URL,
    ZIPHUB_AGENTS_CONFIG: cfgPath,
    ZIPHUB_SUPERVISOR_MISSING_CWD_INTERVAL_MS: "800",
  },
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
});

const hubErr: string[] = [];
const pipe = (stream: any, into?: string[]) => {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        const chunk = dec.decode(value);
        if (into) into.push(chunk);
        process.stderr.write(`[hub] ${chunk}`);
      }
    } catch { /* ignore */ }
  })();
};
pipe(hub.stdout);
pipe(hub.stderr, hubErr);

async function agents(): Promise<any[]> {
  try { return await (await fetch(`${HUB}/api/agents`)).json(); }
  catch { return []; }
}

try {
  // --- Phase 1: supervisor pauses for missing cwd ---
  await new Promise((r) => setTimeout(r, 3000));

  const pausedMsg = hubErr.join("").includes("cwd missing or not a directory");
  check("supervisor logged missing cwd", pausedMsg);

  const countAfterPause = agentRespawnLines(hubErr);
  check("no respawn-loop (no 'exited code' lines)", countAfterPause === 0, { lines: countAfterPause });

  const list1 = await agents();
  check("agent not registered (never spawned)", !list1.some((a: any) => a.id === "ghost" && a.connected));

  // --- Phase 2: create cwd → supervisor resumes ---
  mkdirSync(ghostCwd);
  await new Promise((r) => setTimeout(r, 3500));

  const resumedMsg = hubErr.join("").includes("cwd reappeared");
  check("supervisor logged resume after cwd appeared", resumedMsg);

  const list2 = await agents();
  const online = list2.some((a: any) => a.id === "ghost" && a.connected);
  check("agent now connected after cwd created", online, list2.map((a: any) => ({ id: a.id, connected: a.connected })));
} finally {
  hub.kill("SIGTERM");
  await Promise.race([hub.exited, new Promise((r) => setTimeout(r, 4000))]);
  if (hub.exitCode === null) hub.kill("SIGKILL");
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

function agentRespawnLines(buf: string[]): number {
  const joined = buf.join("");
  return (joined.match(/agent ghost exited code=/g) ?? []).length;
}
