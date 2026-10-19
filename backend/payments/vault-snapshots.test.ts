// The vault totals cache: finalized reads stored in D1 and served from it.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { D1Database } from "../trace/cloudflare-persistence";
import { handlePaymentsApi } from "./handler";
import {
  refreshVaultSnapshots,
  type SnapshotDeployment,
  storeVaultSnapshot,
  type VaultTotals,
} from "./vault-snapshots";

function open(): D1Database {
  const sql = new Database(":memory:");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(`migrations/${file}`, "utf8"));
  function statement(query: string, args: unknown[] = []) {
    return {
      bind: (...values: unknown[]) => statement(query, values),
      async first<T>() {
        return (sql.prepare(query).get(...(args as string[])) ?? null) as T;
      },
      async run() {
        const result = sql.prepare(query).run(...(args as string[]));
        return { success: true, meta: { changes: result.changes } };
      },
    };
  }
  return {
    prepare: statement,
    async batch(items) {
      return Promise.all(items.map((item) => item.run()));
    },
  } as D1Database;
}

const deployment: SnapshotDeployment = {
  projectId: "acme",
  network: "base-sepolia",
  chain: "base",
  vault: "0x2222222222222222222222222222222222222222",
  asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};
const totals = (overrides: Partial<VaultTotals> = {}): VaultTotals => ({
  network: "base-sepolia",
  vault: "0x2222222222222222222222222222222222222222",
  asset: "0x036CBD53842c5426634e7929541eC2318f3dCF7e",
  decimals: 6,
  blockNumber: "1000",
  blockTime: "2026-10-18T10:00:00Z",
  totalDeposited: "500000000",
  totalPaid: "98000000",
  totalPayoutFees: "2000000",
  totalGrossWithdrawn: "0",
  totalWithdrawalFees: "0",
  totalServiceFees: "0",
  freeBalance: "300000000",
  reservedPrincipal: "98000000",
  reservedFees: "2000000",
  accruedFees: "2000000",
  reserved: null,
  ...overrides,
});
const observed = "2026-10-18T10:05:00.000Z";

describe("storeVaultSnapshot", () => {
  test("stores a finalized read under the reviewed vault and asset", async () => {
    const db = open();
    expect(await storeVaultSnapshot(db, deployment, totals(), observed)).toBe(
      "stored",
    );
    const row = await db
      .prepare("SELECT * FROM vault_snapshots WHERE project_id='acme'")
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      asset_address: deployment.asset,
      asset_decimals: 6,
      total_deposited: "500000000",
      reserved: null,
      block_number: "1000",
      block_time: "2026-10-18T10:00:00.000Z",
      observed_at: observed,
    });
  });

  test("rejects a read of another vault or asset, or a malformed counter", async () => {
    const db = open();
    for (const bad of [
      totals({ vault: "0x3333333333333333333333333333333333333333" }),
      totals({ asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }),
      totals({ network: "base-mainnet" }),
      totals({ totalPaid: "1.5" }),
      totals({ totalPaid: "340282366920938463463374607431768211456" }),
      totals({ freeBalance: "-1" }),
      totals({ decimals: 37 }),
      totals({ blockTime: "not a time" }),
    ])
      await expect(
        storeVaultSnapshot(db, deployment, bad, observed),
      ).rejects.toThrow(/reviewed deployment/);
    expect(
      await db
        .prepare("SELECT count(*) n FROM vault_snapshots")
        .first<unknown>(),
    ).toEqual({ n: 0 });
  });

  test("never rewinds: an older block is ignored and a decreasing counter fails", async () => {
    const db = open();
    await storeVaultSnapshot(db, deployment, totals(), observed);
    expect(
      await storeVaultSnapshot(
        db,
        deployment,
        totals({ blockNumber: "999", totalDeposited: "1" }),
        observed,
      ),
    ).toBe("older");
    await expect(
      storeVaultSnapshot(
        db,
        deployment,
        totals({ blockNumber: "1001", totalPaid: "1" }),
        observed,
      ),
    ).rejects.toThrow(/decreased/);
    await expect(
      storeVaultSnapshot(
        db,
        deployment,
        totals({ blockNumber: "1001", decimals: 18 }),
        observed,
      ),
    ).rejects.toThrow(/asset changed/);
    await storeVaultSnapshot(
      db,
      deployment,
      totals({ blockNumber: "1002", totalDeposited: "600000000" }),
      "2026-10-18T10:10:00.000Z",
    );
    expect(
      await db
        .prepare("SELECT total_deposited,block_number FROM vault_snapshots")
        .first<unknown>(),
    ).toEqual({ total_deposited: "600000000", block_number: "1002" });
  });

  test("a Solana read names the project PDA and is stored under the token vault", async () => {
    const db = open();
    const solana: SnapshotDeployment = {
      projectId: "sol",
      network: "solana-devnet",
      chain: "solana",
      vault: "Vau1t11111111111111111111111111111111111111",
      projectPda: "Proj111111111111111111111111111111111111111",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    };
    const read = totals({
      network: "solana-devnet",
      vault: "Proj111111111111111111111111111111111111111",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      freeBalance: "300000000",
      reservedPrincipal: null,
      reservedFees: null,
      accruedFees: null,
      reserved: "100000000",
    });
    await storeVaultSnapshot(db, solana, read, observed);
    expect(
      await db
        .prepare("SELECT vault,reserved,reserved_fees FROM vault_snapshots")
        .first<unknown>(),
    ).toEqual({
      vault: solana.vault,
      reserved: "100000000",
      reserved_fees: null,
    });
    // Base58 is case-sensitive: another case is another account.
    await expect(
      storeVaultSnapshot(
        db,
        solana,
        { ...read, asset: read.asset.toLowerCase() },
        observed,
      ),
    ).rejects.toThrow(/reviewed deployment/);
  });

  test("one failing vault does not stop the others", async () => {
    const db = open();
    const other = { ...deployment, projectId: "beta" };
    await expect(
      refreshVaultSnapshots(
        db,
        [deployment, other],
        { "base-sepolia": "http://rpc.invalid" },
        async (d) => {
          if (d.projectId === "acme") throw new Error("RPC down");
          return totals();
        },
      ),
    ).rejects.toThrow(/Vault snapshot failures/);
    expect(
      await db
        .prepare("SELECT project_id FROM vault_snapshots")
        .first<unknown>(),
    ).toEqual({ project_id: "beta" });
  });
});

describe("GET /api/v1/payments/projects/:id/vault", () => {
  const url = "https://slop.cash/api/v1/payments/projects/acme/vault";
  test("serves cached rows with public edge caching and never reads a chain", async () => {
    const db = open();
    await storeVaultSnapshot(
      db,
      deployment,
      totals({
        totalDeposited: "340282366920938463463374607431768211455",
        freeBalance: null,
      }),
      observed,
    );
    const stored = new Map<string, Response>();
    const edgeCache = {
      match: async (r: Request) => stored.get(r.url)?.clone(),
      put: async (r: Request, response: Response) => {
        stored.set(r.url, response);
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("no network access expected");
    }) as unknown as typeof fetch;
    try {
      const response = await handlePaymentsApi(new Request(url), {
        db,
        edgeCache,
        now: () => new Date(observed),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=60, s-maxage=60",
      );
      const body = (await response.json()) as {
        snapshots: Record<string, unknown>[];
        staleAfterMs: number;
      };
      expect(body.staleAfterMs).toBe(1_800_000);
      expect(body.snapshots).toEqual([
        {
          projectId: "acme",
          network: "base-sepolia",
          chain: "base",
          vault: deployment.vault,
          assetAddress: deployment.asset,
          assetDecimals: 6,
          totalDeposited: "340282366920938463463374607431768211455",
          totalPaid: "98000000",
          totalPayoutFees: "2000000",
          totalGrossWithdrawn: "0",
          totalWithdrawalFees: "0",
          totalServiceFees: "0",
          freeBalance: null,
          reservedPrincipal: "98000000",
          reservedFees: "2000000",
          accruedFees: "2000000",
          reserved: null,
          blockNumber: "1000",
          blockTime: "2026-10-18T10:00:00.000Z",
          observedAt: observed,
        },
      ]);
      // The second read comes from the edge cache, not D1.
      await db.prepare("DELETE FROM vault_snapshots").run();
      const cached = await handlePaymentsApi(new Request(url), {
        db,
        edgeCache,
      });
      expect(
        ((await cached.json()) as { snapshots: unknown[] }).snapshots,
      ).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an unindexed project returns no rows, not zero totals", async () => {
    const response = await handlePaymentsApi(new Request(url), { db: open() });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { snapshots: unknown[] }).snapshots,
    ).toEqual([]);
  });
});

describe("indexPaymentEvent asset", () => {
  const event = {
    kind: "reserved" as const,
    transactionId: `0x${"aa".repeat(32)}`,
    eventIndex: 0,
    blockId: `0x${"bb".repeat(32)}`,
    obligationId: `0x${"cc".repeat(32)}`,
    projectId: "acme",
    network: "base-sepolia",
    chain: "base" as const,
    vault: deployment.vault,
    githubUserId: "7",
    grossMicro: "100000000",
    netMicro: "98000000",
    feeMicro: "2000000",
    sourceDigest: "dd".repeat(32),
  };
  const input = {
    transactionId: event.transactionId,
    eventIndex: 0,
    kind: "reserved" as const,
    obligationId: event.obligationId,
  };
  test("requires the finalized vault snapshot and records its asset and decimals", async () => {
    const { indexPaymentEvent } = await import("./ledger");
    const db = open();
    const adapter = { verifyFinalized: async () => event };
    await expect(
      indexPaymentEvent(db, adapter, input, observed),
    ).rejects.toThrow(/vault asset snapshot/);
    await storeVaultSnapshot(db, deployment, totals(), observed);
    await indexPaymentEvent(db, adapter, input, observed);
    expect(
      await db
        .prepare(
          "SELECT asset_address,asset_decimals,gross_base,fee_base FROM payment_obligations",
        )
        .first<unknown>(),
    ).toEqual({
      asset_address: deployment.asset,
      asset_decimals: 6,
      gross_base: "100000000",
      fee_base: "2000000",
    });
    // Re-indexing the same finalized event is a no-op; changed facts conflict.
    await indexPaymentEvent(db, adapter, input, observed);
    await expect(
      indexPaymentEvent(
        db,
        {
          verifyFinalized: async () => ({
            ...event,
            blockId: `0x${"ee".repeat(32)}`,
          }),
        },
        input,
        observed,
      ),
    ).rejects.toThrow(/Conflicting/);
  });
});
