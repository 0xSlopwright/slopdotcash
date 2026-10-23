import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handleNotifyRequest } from "../notify/handler";
import { dispatchSpendAlert } from "./spend-alerts";

// Real migrations, SQL and HTTP handler. Only the external mail service is
// captured; this does not claim provider acceptance or an inbox delivery.
function harness(rejectMail = false) {
  const sqlite = new Database(":memory:");
  for (const file of [
    "0013_slopbot.sql",
    "0039_slopbot_provider_cost.sql",
    "0049_slopbot_spend_alerts.sql",
  ])
    sqlite.exec(
      readFileSync(
        new URL(`../../migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let bindings: (string | number | null)[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values as typeof bindings;
          return this;
        },
        async first<T>() {
          return statement.get(...bindings) as T | null;
        },
        async run() {
          const result = statement.run(...bindings);
          return { success: true, meta: { changes: result.changes } };
        },
      };
    },
  };
  const mail: string[] = [];
  const notify = {
    fetch: (request: Request) =>
      handleNotifyRequest(request, {
        adminEmails: "admin@example.test",
        fromAddress: "notifications@slop.cash",
        now: () => new Date(),
        randomId: () => crypto.randomUUID(),
        sendEmail: async (_from, _to, body) => {
          mail.push(body);
          if (rejectMail) throw new Error("mail outcome unknown");
        },
      }),
  };
  const add = (
    month: string,
    estimated: number,
    provider: number | null,
    outcome = "ok",
  ) =>
    sqlite
      .prepare(`
    INSERT INTO slopbot_costs(review_key,installation_id,call_kind,route_step,provider,requested_model,outcome,
    input_tokens,cache_write_tokens,cache_read_tokens,output_tokens,price_version,cost_micro_usd,billed_micro_usdc,reconciliation,created_at,provider_cost_micro_usd)
    VALUES ('review',1,'triage',0,'surplus','model',?,0,0,0,0,'price',?,0,'estimated',?,?)
  `)
      .run(outcome, estimated, `${month}-01T00:00:00.000Z`, provider);
  return { sqlite, db, mail, notify, add };
}

test("monthly cost ledger sends every crossed $500 milestone once, including failed calls and prior months", async () => {
  const h = harness();
  try {
    h.add("2026-09", 499_999_999, null);
    h.add("2026-09", 900_000_000, 0); // A real zero overrides the estimate.
    await dispatchSpendAlert(h.db, h.notify);
    expect(h.mail).toHaveLength(0);
    h.add("2026-09", 0, 500_000_001, "failed");
    await Promise.all([
      dispatchSpendAlert(h.db, h.notify),
      dispatchSpendAlert(h.db, h.notify),
    ]);
    expect(h.mail).toHaveLength(1);
    await dispatchSpendAlert(h.db, h.notify);
    expect(h.mail).toHaveLength(2);
    expect(h.mail[0]).toContain("crossed $500.00");
    expect(h.mail[1]).toContain("crossed $1000.00");
    expect(h.mail[0]).toContain("rather than provider-reported charges: 1");
    h.add("2026-10", 500_000_000, null);
    await dispatchSpendAlert(h.db, h.notify);
    await dispatchSpendAlert(h.db, h.notify);
    expect(h.mail).toHaveLength(3);
    expect(h.mail[2]).toContain("2026-10 crossed $500.00");
    expect(
      h.sqlite
        .query(
          "SELECT count(*) AS n FROM slopbot_spend_alert_receipts WHERE outcome='accepted'",
        )
        .get(),
    ).toEqual({ n: 3 });
  } finally {
    h.sqlite.close();
  }
});

test("ambiguous mail is retained and not resent by the next scheduled invocation", async () => {
  const h = harness(true);
  try {
    h.add("2026-10", 500_000_000, null);
    await expect(dispatchSpendAlert(h.db, h.notify)).rejects.toThrow(
      "operator reconciliation",
    );
    await dispatchSpendAlert(h.db, h.notify);
    expect(h.mail).toHaveLength(1);
    expect(
      h.sqlite.query("SELECT outcome FROM slopbot_spend_alert_receipts").get(),
    ).toEqual({ outcome: "ambiguous" });
  } finally {
    h.sqlite.close();
  }
});
