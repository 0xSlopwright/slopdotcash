import type { Network } from "./config";
import type { ConversionRow, ConversionStore } from "./core";

type D1Value = string | number | null;
interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface FeeD1Database {
  prepare(query: string): D1Statement;
}

const LOCK_MS = 14 * 60 * 1000;

const COLUMNS: [keyof ConversionRow, string][] = [
  ["id", "id"],
  ["runId", "run_id"],
  ["network", "network"],
  ["mode", "mode"],
  ["feeWallet", "fee_wallet"],
  ["token", "token"],
  ["targetToken", "target_token"],
  ["amountIn", "amount_in"],
  ["route", "route"],
  ["quoteAmountOut", "quote_amount_out"],
  ["minAmountOut", "min_amount_out"],
  ["quoteValueMicro", "quote_value_micro"],
  ["priceImpactBps", "price_impact_bps"],
  ["quote", "quote"],
  ["approvalTxId", "approval_tx_id"],
  ["txId", "tx_id"],
  ["rawTx", "raw_tx"],
  ["evmNonce", "evm_nonce"],
  ["expiresAt", "expires_at"],
  ["amountOut", "amount_out"],
  ["tokenBalanceBefore", "token_balance_before"],
  ["targetBalanceBefore", "target_balance_before"],
  ["targetBalanceAfter", "target_balance_after"],
  ["state", "state"],
  ["reason", "reason"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
  ["submittedAt", "submitted_at"],
  ["finalizedAt", "finalized_at"],
];
const COLUMN = new Map(COLUMNS);
const SELECT = COLUMNS.map(([, column]) => column).join(", ");

function fromRow(row: Record<string, D1Value>): ConversionRow {
  return Object.fromEntries(
    COLUMNS.map(([key, column]) => [key, row[column] ?? null]),
  ) as unknown as ConversionRow;
}

export class D1ConversionStore implements ConversionStore {
  constructor(private readonly db: FeeD1Database) {}

  async acquireLock(network: Network, runId: string, now: Date) {
    const expires = new Date(now.getTime() + LOCK_MS).toISOString();
    const result = await this.db
      .prepare(
        `INSERT INTO fee_converter_locks (network, run_id, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(network) DO UPDATE SET run_id = excluded.run_id,
           expires_at = excluded.expires_at
         WHERE fee_converter_locks.expires_at < ?`,
      )
      .bind(network, runId, expires, now.toISOString())
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async releaseLock(network: Network, runId: string) {
    await this.db
      .prepare(
        "DELETE FROM fee_converter_locks WHERE network = ? AND run_id = ?",
      )
      .bind(network, runId)
      .run();
  }

  async openRows(network: Network) {
    const { results } = await this.db
      .prepare(
        `SELECT ${SELECT} FROM fee_conversions
          WHERE network = ? AND mode = 'live'
            AND state IN ('submitted', 'unknown', 'quoted')
          ORDER BY created_at`,
      )
      .bind(network)
      .all<Record<string, D1Value>>();
    return results.map(fromRow);
  }

  async insert(row: ConversionRow) {
    await this.db
      .prepare(
        `INSERT INTO fee_conversions (${SELECT}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
      )
      .bind(...COLUMNS.map(([key]) => row[key] as D1Value))
      .run();
  }

  async update(id: string, fields: Partial<ConversionRow>) {
    const entries = Object.entries(fields).filter(
      ([key]) => key !== "id" && key !== "createdAt",
    );
    if (entries.length === 0) return;
    const result = await this.db
      .prepare(
        `UPDATE fee_conversions SET ${entries
          .map(([key]) => {
            const column = COLUMN.get(key as keyof ConversionRow);
            if (!column) throw new TypeError(`Unknown field ${key}`);
            return `${column} = ?`;
          })
          .join(", ")} WHERE id = ?`,
      )
      .bind(...entries.map(([, value]) => value as D1Value), id)
      .run();
    if ((result.meta?.changes ?? 0) !== 1)
      throw new Error("Fee conversion record was not updated");
  }

  async liveValueSince(network: Network, since: string) {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(quote_value_micro), 0) AS total FROM fee_conversions
          WHERE network = ? AND mode = 'live'
            AND state IN ('submitted', 'unknown', 'finalized')
            AND created_at >= ?`,
      )
      .bind(network, since)
      .first<{ total: number }>();
    return BigInt(row?.total ?? 0);
  }

  async latest(network: Network, token: string) {
    const row = await this.db
      .prepare(
        `SELECT ${SELECT} FROM fee_conversions WHERE network = ? AND token = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(network, token)
      .first<Record<string, D1Value>>();
    return row ? fromRow(row) : null;
  }
}

/**
 * Reward tokens named by D1 project manifests for one network: a token
 * `rewardAsset` on the network, and the asset of each escrow deployment on its
 * escrow network keys. Only reviewed manifests contribute; tokens that merely
 * arrive in the fee wallet are never discovered.
 */
export async function projectRewardTokens(
  db: FeeD1Database,
  network: string,
  escrowNetworks: readonly string[],
): Promise<string[]> {
  const [rewardAssets, deployments] = await Promise.all([
    db
      .prepare(
        `SELECT DISTINCT json_extract(manifest, '$.rewardAsset.address') AS asset
           FROM projects
          WHERE json_extract(manifest, '$.rewardAsset.network') = ?
            AND json_extract(manifest, '$.rewardAsset.kind') = 'token'`,
      )
      .bind(network)
      .all<{ asset: unknown }>(),
    db
      .prepare(
        `SELECT DISTINCT json_extract(d.value, '$.asset') AS asset
           FROM projects, json_each(projects.manifest, '$.escrow.deployments') AS d
          WHERE json_extract(d.value, '$.network') IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(escrowNetworks))
      .all<{ asset: unknown }>(),
  ]);
  return [
    ...new Set(
      [...rewardAssets.results, ...deployments.results].map((row) => row.asset),
    ),
  ].filter((asset): asset is string => typeof asset === "string");
}
