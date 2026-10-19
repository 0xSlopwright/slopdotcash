/**
 * Runs D1 statements against an in-memory SQLite database with the real
 * migrations, so registry tests exercise the actual tables and triggers.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectD1Database } from "../backend/projects/cloudflare-persistence";

type Statement = ReturnType<ProjectD1Database["prepare"]> & {
  runSync(): { success: boolean; meta: { changes: number } };
};

export function sqliteD1(migrations: string[]): {
  db: ProjectD1Database;
  sqlite: Database;
} {
  const sqlite = new Database(":memory:");
  const root = resolve(import.meta.dir, "..", "migrations");
  for (const migration of migrations)
    sqlite.exec(readFileSync(join(root, migration), "utf8"));
  const statement = (sql: string, values: unknown[] = []): Statement => {
    const params = values as never[];
    const runSync = () => ({
      success: true,
      meta: { changes: sqlite.prepare(sql).run(...params).changes },
    });
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async <T>() =>
        (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
      all: async <T>() => ({
        success: true,
        results: sqlite.prepare(sql).all(...params) as T[],
      }),
      run: async () => runSync(),
      runSync,
    };
  };
  const db: ProjectD1Database = {
    prepare: (sql) => statement(sql),
    batch: async (statements) =>
      sqlite.transaction(() =>
        (statements as Statement[]).map((entry) => entry.runSync()),
      )(),
  };
  return { db, sqlite };
}
