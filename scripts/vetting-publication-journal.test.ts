import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { d1PublicationJournal } from "../workers/vetting/publication-journal";

let db: Database;
let loseReply: boolean;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE vetting_assessments(id TEXT PRIMARY KEY); INSERT INTO vetting_assessments VALUES('assessment-a')",
  );
  db.exec(
    readFileSync("migrations/0074_vetting_publication_journal.sql", "utf8"),
  );
  loseReply = false;
});
afterEach(() => db.close());
const intent = {
  assessmentId: "assessment-a",
  origin: "https://staging.slop.cash",
  resultSha256: "a".repeat(64),
  disposition: "incomplete",
};
function journal() {
  return d1PublicationJournal({
    accountId: "b".repeat(32),
    databaseId: "00000000-0000-0000-0000-000000000001",
    token: "test-token",
    fetch: Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        const { sql, params } = JSON.parse(String(init?.body));
        try {
          const results = db.prepare(sql).all(...params);
          if (loseReply) {
            loseReply = false;
            throw new Error("Lost durable reservation response");
          }
          return Response.json({
            success: true,
            result: [{ success: true, results }],
          });
        } catch (error) {
          if ((error as Error).message === "Lost durable reservation response")
            throw error;
          return Response.json({ success: false, result: [] });
        }
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  });
}

test("a restarted controller preserves an intent even when its reservation reply is lost", async () => {
  expect(await journal().has(intent.assessmentId)).toBe(false);
  loseReply = true;
  await expect(journal().reserve(intent)).rejects.toThrow(
    "Lost durable reservation response",
  );
  expect(await journal().has(intent.assessmentId)).toBe(true);
  await expect(journal().reserve(intent)).rejects.toThrow("already reserved");
  expect(
    db.query("SELECT count(*) n FROM vetting_publication_intents").get(),
  ).toEqual({ n: 1 });
});

test("only one concurrent controller can reserve a publication and its metadata stays immutable", async () => {
  const attempts = await Promise.allSettled([
    journal().reserve(intent),
    journal().reserve(intent),
  ]);
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(() =>
    db.exec("UPDATE vetting_publication_intents SET result_sha256='changed'"),
  ).toThrow("immutable");
  expect(() => db.exec("DELETE FROM vetting_publication_intents")).toThrow(
    "immutable",
  );
});

test("a receipt must match the reserved result and remains exactly once", async () => {
  await journal().reserve(intent);
  const receipt = { ...intent, outcome: "unknown" as const, httpStatus: null };
  await expect(
    journal().complete({ ...receipt, resultSha256: "c".repeat(64) }),
  ).rejects.toThrow("matching intent");
  await journal().complete(receipt);
  await expect(
    journal().complete({ ...receipt, outcome: "accepted" }),
  ).rejects.toThrow();
  expect(
    db
      .query("SELECT outcome,http_status FROM vetting_publication_receipts")
      .get(),
  ).toEqual({ outcome: "unknown", http_status: null });
  expect(() => db.exec("DELETE FROM vetting_publication_receipts")).toThrow(
    "immutable",
  );
});
