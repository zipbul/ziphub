import { SQL } from "bun";

const DEFAULT_URL = "postgres://ziphub@127.0.0.1:5432/ziphub";

export type TaskState =
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentRow {
  id: string;
  name?: string;
  capabilities: string[];
  version?: string;
  endpoint: string;
  registeredAt: string;
  lastSeenAt: string;
}

export interface TaskRow {
  id: string;
  agentId: string;
  fromAgentId?: string;
  state: TaskState;
  input: unknown;
  output?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EventRow {
  id: number;
  agentId: string | null;
  kind: string;
  payload: unknown;
  createdAt: string;
}

function ts(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

function rowToAgent(r: any): AgentRow {
  const caps = parseJson<unknown>(r.capabilities, []);
  return {
    id: r.id,
    name: r.name ?? undefined,
    capabilities: Array.isArray(caps) ? (caps as string[]) : [],
    version: r.version ?? undefined,
    endpoint: r.endpoint,
    registeredAt: ts(r.registered_at),
    lastSeenAt: ts(r.last_seen_at),
  };
}

function rowToTask(r: any): TaskRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    fromAgentId: r.from_agent_id ?? undefined,
    state: r.state as TaskState,
    input: parseJson<unknown>(r.input, null),
    output: r.output === null || r.output === undefined ? undefined : parseJson<unknown>(r.output, null),
    error: r.error ?? undefined,
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

function rowToEvent(r: any): EventRow {
  return {
    id: Number(r.id),
    agentId: r.agent_id ?? null,
    kind: r.kind,
    payload: parseJson<unknown>(r.payload, null),
    createdAt: ts(r.created_at),
  };
}

export class Storage {
  private readonly sql: SQL;

  constructor(opts: { url?: string } = {}) {
    const url =
      opts.url ??
      process.env.ZIPHUB_DATABASE_URL ??
      process.env.DATABASE_URL ??
      DEFAULT_URL;
    this.sql = new SQL(url);
  }

  async init(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS agents (
        id            TEXT PRIMARY KEY,
        name          TEXT,
        capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
        version       TEXT,
        endpoint      TEXT NOT NULL,
        registered_at TIMESTAMPTZ NOT NULL,
        last_seen_at  TIMESTAMPTZ NOT NULL
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        from_agent_id TEXT,
        state         TEXT NOT NULL,
        input         JSONB NOT NULL,
        output        JSONB,
        error         TEXT,
        created_at    TIMESTAMPTZ NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS events (
        id         BIGSERIAL PRIMARY KEY,
        agent_id   TEXT,
        kind       TEXT NOT NULL,
        payload    JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)`;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  // ----- agents -----
  async getAgent(id: string): Promise<AgentRow | undefined> {
    const rows = (await this.sql`SELECT * FROM agents WHERE id = ${id}`) as any[];
    return rows[0] ? rowToAgent(rows[0]) : undefined;
  }

  async listAgents(): Promise<AgentRow[]> {
    const rows = (await this.sql`SELECT * FROM agents ORDER BY id`) as any[];
    return rows.map(rowToAgent);
  }

  async upsertAgent(row: AgentRow): Promise<void> {
    await this.sql`
      INSERT INTO agents (id, name, capabilities, version, endpoint, registered_at, last_seen_at)
      VALUES (
        ${row.id},
        ${row.name ?? null},
        ${row.capabilities},
        ${row.version ?? null},
        ${row.endpoint},
        ${row.registeredAt},
        ${row.lastSeenAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        capabilities = EXCLUDED.capabilities,
        version = EXCLUDED.version,
        endpoint = EXCLUDED.endpoint,
        last_seen_at = EXCLUDED.last_seen_at
    `;
  }

  async deleteAgent(id: string): Promise<void> {
    await this.sql`DELETE FROM agents WHERE id = ${id}`;
  }

  async touchAgent(id: string, at: string): Promise<void> {
    await this.sql`UPDATE agents SET last_seen_at = ${at} WHERE id = ${id}`;
  }

  // ----- tasks -----
  async getTask(id: string): Promise<TaskRow | undefined> {
    const rows = (await this.sql`SELECT * FROM tasks WHERE id = ${id}`) as any[];
    return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async listTasks(limit = 200): Promise<TaskRow[]> {
    const rows = (await this.sql`
      SELECT * FROM tasks ORDER BY created_at DESC LIMIT ${limit}
    `) as any[];
    return rows.map(rowToTask);
  }

  async upsertTask(row: TaskRow): Promise<void> {
    await this.sql`
      INSERT INTO tasks (id, agent_id, from_agent_id, state, input, output, error, created_at, updated_at)
      VALUES (
        ${row.id},
        ${row.agentId},
        ${row.fromAgentId ?? null},
        ${row.state},
        ${row.input ?? null},
        ${row.output ?? null},
        ${row.error ?? null},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        state = EXCLUDED.state,
        output = EXCLUDED.output,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async pendingTasksForAgent(agentId: string): Promise<TaskRow[]> {
    const rows = (await this.sql`
      SELECT * FROM tasks
      WHERE agent_id = ${agentId} AND state = 'submitted'
      ORDER BY created_at
    `) as any[];
    return rows.map(rowToTask);
  }

  async inflightTasksForAgent(agentId: string): Promise<string[]> {
    const rows = (await this.sql`
      SELECT id FROM tasks
      WHERE agent_id = ${agentId} AND state IN ('submitted', 'working')
    `) as any[];
    return rows.map((r) => r.id as string);
  }

  async recoverWorkingToSubmitted(agentId: string, at: string): Promise<string[]> {
    const rows = (await this.sql`
      UPDATE tasks
      SET state = 'submitted', updated_at = ${at}
      WHERE agent_id = ${agentId} AND state = 'working'
      RETURNING id
    `) as any[];
    return rows.map((r) => r.id as string);
  }

  // ----- events -----
  async appendEvent(
    agentId: string | null,
    kind: string,
    payload: unknown,
    at: string,
  ): Promise<EventRow> {
    const rows = (await this.sql`
      INSERT INTO events (agent_id, kind, payload, created_at)
      VALUES (${agentId}, ${kind}, ${payload ?? null}, ${at})
      RETURNING *
    `) as any[];
    return rowToEvent(rows[0]);
  }

  async recentEvents(limit = 200): Promise<EventRow[]> {
    const rows = (await this.sql`
      SELECT * FROM events ORDER BY id DESC LIMIT ${limit}
    `) as any[];
    return rows.map(rowToEvent);
  }

  async taskSteps(
    taskId: string,
    limit = 20,
  ): Promise<{ count: number; recent: { at: string; payload: Record<string, unknown> }[] }> {
    const countRows = (await this.sql`
      SELECT COUNT(*)::int AS n FROM events
      WHERE kind = 'task.step' AND payload->>'taskId' = ${taskId}
    `) as any[];
    const count = Number(countRows[0]?.n ?? 0);

    const recentRows = (await this.sql`
      SELECT created_at, payload FROM events
      WHERE kind = 'task.step' AND payload->>'taskId' = ${taskId}
      ORDER BY id DESC
      LIMIT ${limit}
    `) as any[];

    const recent = recentRows.map((r) => {
      const payload = r.payload as Record<string, unknown>;
      const step = (payload.step as Record<string, unknown> | undefined) ?? {};
      const at = (step.at as string | undefined) ?? ts(r.created_at);
      return { at, payload };
    });

    return { count, recent };
  }
}
