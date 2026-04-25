import { SQL } from "bun";

export const TEST_DATABASE_URL =
  process.env.ZIPHUB_TEST_DATABASE_URL ?? "postgres://ziphub@127.0.0.1:5432/ziphub_test";

/** Wipe all ziphub tables. Hub init will recreate them on next boot. */
export async function resetTestDb(url: string = TEST_DATABASE_URL): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql`DROP TABLE IF EXISTS agents, tasks, events CASCADE`;
  } finally {
    await sql.end();
  }
}
