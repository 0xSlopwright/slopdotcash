import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { handlePointsApi } from "../backend/points/handler";
import type { PointsJournal } from "../src/lib/points";
import { sqliteD1 } from "../tests/sqlite-d1";
import { pointsSql } from "./generate-points";

test("points publication retains the exact permanent history prefix", async () => {
  const checkpoint = JSON.parse(
    readFileSync("data/points/history.json", "utf8"),
  ) as PointsJournal;
  const first = { ...checkpoint, revisions: checkpoint.revisions.slice(0, 2) };
  const next = {
    ...checkpoint,
    generatedAt: new Date(
      Date.parse(checkpoint.generatedAt) + 1000,
    ).toISOString(),
    revisions: checkpoint.revisions.slice(0, 3),
  };
  const reordered = {
    ...next,
    revisions: [next.revisions[1], next.revisions[0], next.revisions[2]],
  };
  const migration = "0037_points_batch_prefix.sql";
  const { db: adapter, sqlite: db } = sqliteD1(
    readdirSync("migrations")
      .filter((path) => path.endsWith(".sql") && path !== migration)
      .sort(),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      handlePointsApi(request, {
        db: adapter,
        rateLimitSecret: "",
        identity: { fetch: async () => new Response(null, { status: 503 }) },
        allowedOrigins: [new URL(request.url).origin],
      }),
  });
  const readJournal = async () => {
    const response = await fetch(new URL("/api/v1/points/journal", server.url));
    expect(response.status).toBe(200);
    const { batch, next: cursor, total, ...journal } = await response.json();
    expect(cursor).toBeNull();
    expect(total).toBe(journal.revisions.length);
    expect(
      createHash("sha256").update(JSON.stringify(journal)).digest("hex"),
    ).toBe(batch);
    return journal;
  };
  const apply = (journal: PointsJournal) => {
    db.transaction(() => {
      for (const statement of pointsSql(journal).trim().split("\n"))
        db.exec(statement);
    })();
  };
  const rows = () =>
    db.query("SELECT id,payload FROM points_revisions ORDER BY rowid").all();
  try {
    apply(first);
    const permanent = rows();
    expect((await readJournal()).revisions).toEqual(first.revisions);
    // Upgrade an already populated database, as the release workflow does.
    db.exec(readFileSync(`migrations/${migration}`, "utf8"));
    // Each candidate is a valid journal; only its relationship to D1 differs.
    expect(() => apply(reordered)).toThrow("divergent points batch");
    expect(rows()).toEqual(permanent);
    expect(db.query("SELECT COUNT(*) AS n FROM points_batches").get()).toEqual({
      n: 1,
    });
    expect((await readJournal()).revisions).toEqual(first.revisions);
    apply(next);
    expect((await readJournal()).revisions).toEqual(next.revisions);
    expect(rows().map((row) => (row as { id: string }).id)).toEqual(
      next.revisions.map((revision) => revision.id),
    );
    expect(() => apply(next)).not.toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM points_staging").get()).toEqual({
      n: 0,
    });
  } finally {
    server.stop(true);
    db.close();
  }
});
