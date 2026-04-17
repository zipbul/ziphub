import { Database } from "bun:sqlite";

export function openDb(path = process.env.ZIPHUB_DB ?? "ziphub.db"): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      capabilities  TEXT NOT NULL DEFAULT '[]',
      version       TEXT,
      token_hash    TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id             TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL,
      from_agent_id  TEXT,
      state          TEXT NOT NULL,
      input          TEXT NOT NULL,
      output         TEXT,
      error          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id   TEXT,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
  `);
  return db;
}
