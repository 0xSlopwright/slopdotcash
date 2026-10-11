/**
 * Writes the idempotent D1 import for every observed transfer in the reviewed
 * direct-payment disclosures. The deploy runs it after the slop-private
 * migrations. It refuses to write anything unless every disclosure reproduces
 * from its frozen preparation, and the database refuses a row that contradicts
 * an earlier import. It reads no chain and authorizes no payment.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubUserIdFromNodeId } from "../src/lib/github-actor";
import {
  checkDirectPaymentDisclosures,
  type Disclosure,
} from "./check-direct-payment-disclosures";

const CHAINS: Record<string, "solana" | "base"> = {
  "solana-mainnet": "solana",
};

export function directPaymentsSql(root: string, importedAt: string): string {
  const failures = checkDirectPaymentDisclosures(root);
  if (failures.length) throw new Error(failures.join("\n"));
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const statements: string[] = [];
  for (const name of readdirSync(join(root, "disclosures"))
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const path = `disclosures/${name}`;
    const d = JSON.parse(
      readFileSync(join(root, path), "utf8"),
    ) as Disclosure & { network: string; asset: string };
    const chain = CHAINS[d.network];
    if (!chain || d.asset !== "USDC")
      throw new Error(`${path}: unsupported network or asset`);
    if (
      !/^[a-z0-9][a-z0-9-]*$/u.test(d.projectId) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/u.test(d.contributionMonth)
    )
      throw new Error(`${path}: invalid project or month`);
    for (const row of d.rows) {
      if (row.state !== "paid-direct" || !row.observed) continue;
      const o = row.observed;
      const githubUserId = githubUserIdFromNodeId(row.actorId);
      if (
        !githubUserId ||
        !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/u.test(o.signature) ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(o.recipient) ||
        !/^[1-9]\d*$/u.test(o.amountMinor) ||
        !Number.isSafeInteger(o.slot) ||
        Number.isNaN(Date.parse(o.blockTime))
      )
        throw new Error(`${path}: invalid observed transfer for ${row.login}`);
      const values = [
        d.network,
        o.signature,
        d.projectId,
        d.contributionMonth,
        githubUserId,
        row.actorId,
        row.login,
        chain,
        o.recipient,
        o.amountMinor,
        o.blockTime,
        String(o.slot),
        path,
        importedAt,
      ].map(quote);
      statements.push(
        `INSERT INTO payment_direct_transfers VALUES(${values.join(",")}) ON CONFLICT(network,transaction_id) DO UPDATE SET github_login=excluded.github_login,source_path=excluded.source_path WHERE github_login!=excluded.github_login OR source_path!=excluded.source_path;`,
      );
    }
  }
  if (!statements.length) throw new Error("no observed direct transfers");
  return `${statements.join("\n")}\n`;
}

if (import.meta.main) {
  if (process.argv.length !== 3)
    throw new Error("Usage: prepare-payments-import.ts OUTPUT_SQL");
  writeFileSync(
    process.argv[2],
    directPaymentsSql(process.cwd(), new Date().toISOString()),
  );
}
