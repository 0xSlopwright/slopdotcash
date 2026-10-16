import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  consumeVerificationAdmission,
  VERIFICATION_ADMISSION,
} from "../backend/trace/verification-admission";

const SECRET = "verification-admission-test-secret-0123456789";
const NOW = 1_800_000_000;

function database() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("migrations/0004_identity_rate_limits.sql", "utf8"));
  const db = {
    prepare(sql: string) {
      let values: (string | number)[] = [];
      const statement = {
        bind(...next: (string | number)[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          return (sqlite.query(sql).get(...values) as T | null) ?? null;
        },
        async run() {
          const result = sqlite.query(sql).run(...values);
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  };
  return db as unknown as Parameters<typeof consumeVerificationAdmission>[0];
}

function admit(db: ReturnType<typeof database>, principal: string) {
  return consumeVerificationAdmission(db, {
    principal,
    secret: SECRET,
    nowEpochSeconds: NOW,
  });
}

test("one client over its own quota does not use the shared verification budget", async () => {
  const db = database();
  // A single address sends far more requests than its own quota in one window.
  for (let index = 0; index < VERIFICATION_ADMISSION.globalLimit * 2; index++) {
    await admit(db, "203.0.113.7");
  }
  // Another address in the same window must still be admitted.
  const other = await admit(db, "198.51.100.9");
  expect(other.allowed).toBe(true);
});

test("a client is still limited to its own quota", async () => {
  const db = database();
  const results = [];
  for (let index = 0; index < VERIFICATION_ADMISSION.clientLimit + 2; index++) {
    results.push((await admit(db, "203.0.113.7")).allowed);
  }
  expect(results).toEqual([true, true, true, true, false, false]);
});

test("the shared budget still stops distinct clients at the global limit", async () => {
  const db = database();
  let allowed = 0;
  for (
    let index = 0;
    index < VERIFICATION_ADMISSION.globalLimit + 10;
    index++
  ) {
    // Distinct addresses; 1024 buckets make collisions possible, so use a spread.
    if ((await admit(db, `198.51.${index}.${index + 1}`)).allowed) allowed++;
  }
  expect(allowed).toBeLessThanOrEqual(VERIFICATION_ADMISSION.globalLimit);
  expect(allowed).toBeGreaterThan(0);
});
