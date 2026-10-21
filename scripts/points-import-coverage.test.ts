import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { handlePointsApi } from "../backend/points/handler";
import type { PointsJournal } from "../src/lib/points";
import { sqliteD1 } from "../tests/sqlite-d1";
import { pointsSql } from "./generate-points";

// https://developers.cloudflare.com/d1/platform/limits/
const D1_MAX_STATEMENT_BYTES = 100_000;

// Every snapshot application adds one coverage entry per repository, so the
// production coverage only grows. 700 entries is about 120 KB of JSON.
function journalWithCoverage(entries: number): PointsJournal {
  const checkpoint = JSON.parse(
    readFileSync("data/points/history.json", "utf8"),
  ) as PointsJournal;
  const repositories = checkpoint.coverage.map((c) => c.repository);
  return {
    ...checkpoint,
    revisions: checkpoint.revisions.slice(0, 3),
    coverage: Array.from({ length: entries }, (_, i) => ({
      repository: repositories[i % repositories.length],
      from: "2026-09-01T00:00:00.000Z",
      to: new Date(
        Date.parse("2026-09-21T00:00:00.000Z") + i * 60000,
      ).toISOString(),
      digest: createHash("sha256").update(String(i)).digest("hex"),
    })),
  };
}

test("every points import statement fits the D1 statement limit", () => {
  const journal = journalWithCoverage(700);
  expect(JSON.stringify(journal.coverage).length).toBeGreaterThan(
    D1_MAX_STATEMENT_BYTES,
  );
  for (const statement of pointsSql(journal).trim().split("\n"))
    expect(Buffer.byteLength(statement)).toBeLessThanOrEqual(
      D1_MAX_STATEMENT_BYTES,
    );
});

test("a staged coverage list is served whole and an incomplete one publishes nothing", async () => {
  const journal = journalWithCoverage(700);
  const { db: adapter, sqlite: db } = sqliteD1(
    readdirSync("migrations")
      .filter((path) => path.endsWith(".sql"))
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
  const apply = (statements: string[]) => {
    db.transaction(() => {
      for (const statement of statements) db.exec(statement);
    })();
  };
  const statements = pointsSql(journal).trim().split("\n");
  const count = (table: string) =>
    db.query(`SELECT COUNT(*) AS n FROM ${table}`).get();
  try {
    // A statement-by-statement executor can lose one upload and still run the
    // batch statement; that batch must fail instead of recording less coverage.
    const isRecord = (s: string) => s.startsWith("INSERT INTO points_batches(");
    const record = statements.filter(isRecord);
    expect(record).toHaveLength(1);
    const lost = statements.findLastIndex((s) =>
      s.startsWith("INSERT INTO points_coverage_staging("),
    );
    expect(lost).toBeGreaterThan(-1);
    for (const [i, statement] of statements.entries())
      if (i !== lost && !isRecord(statement)) db.exec(statement);
    expect(() => db.exec(record.join("\n"))).toThrow();
    expect(count("points_batches")).toEqual({ n: 0 });
    expect(count("points_revisions")).toEqual({ n: 0 });

    apply(statements);
    const response = await fetch(new URL("/api/v1/points/journal", server.url));
    expect(response.status).toBe(200);
    const { batch, next, total, ...served } = await response.json();
    expect(next).toBeNull();
    expect(total).toBe(journal.revisions.length);
    expect(served).toEqual(journal);
    expect(
      createHash("sha256").update(JSON.stringify(served)).digest("hex"),
    ).toBe(batch);
    expect(count("points_staging")).toEqual({ n: 0 });
    expect(count("points_coverage_staging")).toEqual({ n: 0 });

    // Replaying a recorded batch changes nothing and leaves no staged rows.
    apply(statements);
    expect(count("points_batches")).toEqual({ n: 1 });
    expect(count("points_coverage_staging")).toEqual({ n: 0 });
  } finally {
    server.stop(true);
    db.close();
  }
});
