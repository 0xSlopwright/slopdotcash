// Live cycle against a local Anvil fork of Base mainnet with a throwaway key.
// Nothing reaches a real chain: Anvil holds the fork, the key is generated
// here, and the test token arrives by impersonating a holder on the fork.
// KyberSwap's public API is only read for a route.
//   bun workers/fee-converter/fork.integration.ts [fork-rpc-url]
import { encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { runOnce } from "./index";
import { sqliteD1 } from "./sqlite-d1";

const FORK_URL = process.argv[2] ?? "https://mainnet.base.org";
const PORT = 28545;
const RPC = `http://127.0.0.1:${PORT}`;
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const HOLDER = "0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// A fork-only copy of the AERO contract: an ERC-20 no aggregator knows.
const UNROUTED = "0x00000000000000000000000000000000000f0e10";

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const word = (address: string) => address.slice(2).padStart(64, "0");
async function balanceOf(token: string, owner: string) {
  return BigInt(
    (await rpc("eth_call", [
      { to: token, data: `0x70a08231${word(owner)}` },
      "latest",
    ])) as string,
  );
}

try {
  await rpc("eth_chainId", []);
  throw new Error(`port ${PORT} is already serving a node; stop it first`);
} catch (error) {
  if (String(error).includes("already serving")) throw error;
}
const anvil = Bun.spawn(
  ["anvil", "--fork-url", FORK_URL, "--port", String(PORT), "--silent"],
  { stdout: "ignore", stderr: "inherit" },
);
try {
  for (let i = 0; ; i++) {
    try {
      await rpc("eth_chainId", []);
      break;
    } catch {
      if (i > 60) throw new Error("anvil did not start");
      await Bun.sleep(500);
    }
  }
  const key = generatePrivateKey();
  const wallet = privateKeyToAccount(key).address.toLowerCase();
  console.log(
    `throwaway fee wallet ${wallet} on fork chain ${await rpc("eth_chainId", [])}`,
  );
  await rpc("anvil_setBalance", [wallet, "0xde0b6b3a7640000"]);
  await rpc("anvil_setBalance", [HOLDER, "0xde0b6b3a7640000"]);
  await rpc("anvil_setCode", [
    UNROUTED,
    await rpc("eth_getCode", [AERO, "latest"]),
  ]);
  const seed = async (amount = 50n * 10n ** 18n) => {
    await rpc("anvil_impersonateAccount", [HOLDER]);
    await rpc("eth_sendTransaction", [
      {
        from: HOLDER,
        to: AERO,
        data: `0xa9059cbb${word(wallet)}${amount.toString(16).padStart(64, "0")}`,
      },
    ]);
    await rpc("anvil_stopImpersonatingAccount", [HOLDER]);
    console.log(`seeded ${await balanceOf(AERO, wallet)} AERO base units`);
  };

  const { db, sqlite } = sqliteD1();
  const env = {
    FEE_DB: db,
    FEE_CONVERTER_MODE: "live",
    FEE_CONVERTER_NETWORKS: "base",
    FEE_WALLET_BASE: wallet,
    FEE_WALLET_KEY_BASE: key,
    RPC_URL_BASE: RPC,
    // Harness limits for a local chain only; production limits come from
    // the reviewed wrangler.toml.
    FEE_CONVERTER_MIN_VALUE_MICRO: "1000000",
    FEE_CONVERTER_GAS_MULTIPLE: "10",
    FEE_CONVERTER_MAX_SLIPPAGE_BPS: "100",
    FEE_CONVERTER_MAX_PRICE_IMPACT_BPS: "200",
    FEE_CONVERTER_RUN_CAP_MICRO: "1000000000",
    FEE_CONVERTER_DAILY_CAP_MICRO: "5000000000",
    FEE_CONVERTER_ALLOWLIST: JSON.stringify({ base: [AERO, UNROUTED] }),
  };
  // Loses the swap send of a run (the approval is the first raw send),
  // either before it reaches the node or after the node accepted it.
  const faulty = (when: "before" | "after"): typeof fetch => {
    let sends = 0;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const isSend = body.includes('"eth_sendRawTransaction"');
      // Every later send of the run fails too, so the transport retry
      // cannot mask the fault; "after" delivers the first copy only.
      if (isSend && ++sends >= 2) {
        if (when === "after" && sends === 2) await fetch(input, init);
        throw new Error("simulated network fault");
      }
      return fetch(input, init);
    }) as typeof fetch;
  };
  const state = (token = AERO) =>
    sqlite
      .query(
        "SELECT state, reason FROM fee_conversions WHERE token = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(token) as { state: string; reason: string | null };
  // Reports a better first quote than the market, as if the price fell
  // between quote and signing; the fresh route at signing must refuse it.
  const inflatedFirstQuote = (): typeof fetch => {
    let inflated = false;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (inflated || !String(input).includes("/api/v1/routes?"))
        return response;
      inflated = true;
      const body = await response.json();
      const out = BigInt(body.data.routeSummary.amountOut);
      body.data.routeSummary.amountOut = ((out * 105n) / 100n).toString();
      return new Response(JSON.stringify(body), { status: response.status });
    }) as typeof fetch;
  };
  const expect = (
    actual: { state: string; reason: string | null },
    wanted: string,
    step: string,
  ) => {
    console.log(
      `${step}: ${actual.state}${actual.reason ? ` (${actual.reason})` : ""}`,
    );
    if (actual.state !== wanted)
      throw new Error(`${step}: expected ${wanted}, got ${actual.state}`);
  };
  const usdcBefore = await balanceOf(USDC, wallet);

  // 1. Ordinary send, finalized on the next run.
  await seed();
  console.log("run:", JSON.stringify(await runOnce(env)));
  expect(state(), "submitted", "1 after send");
  await rpc("anvil_mine", ["0x80"]); // Anvil finalizes only after later blocks.
  await runOnce(env);
  expect(state(), "finalized", "1 after reconcile");

  // 2. Swap lost before delivery: recorded unknown, rebroadcast unchanged, finalized.
  await seed();
  await runOnce(env, undefined, { fetch: faulty("before") });
  expect(state(), "unknown", "2 after lost send");
  await runOnce(env);
  expect(state(), "submitted", "2 after rebroadcast");
  await rpc("anvil_mine", ["0x80"]);
  await runOnce(env);
  expect(state(), "finalized", "2 after reconcile");

  // 3. Swap delivered but the response lost: reconciled from the receipt, no resend.
  await seed();
  await runOnce(env, undefined, { fetch: faulty("after") });
  expect(state(), "unknown", "3 after lost response");
  await rpc("anvil_mine", ["0x80"]);
  await runOnce(env);
  expect(state(), "finalized", "3 after reconcile");

  // 4. Below the minimum value: skipped, nothing signed.
  await seed(10n ** 18n); // 1 AERO, under the 1 USDC minimum
  await runOnce(env);
  expect(state(), "skipped", "4 below minimum");

  // 5. Price moved between quote and signing: refused before signing.
  await seed(49n * 10n ** 18n);
  await runOnce(env, undefined, { fetch: inflatedFirstQuote() });
  expect(state(), "failed", "5 slippage refusal");

  // 6. A token no aggregator can route: no_route. The AERO balance converts.
  await rpc("anvil_setStorageAt", [
    UNROUTED,
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [wallet as `0x${string}`, 0n],
      ),
    ),
    `0x${(1000n * 10n ** 18n).toString(16).padStart(64, "0")}`,
  ]);
  await runOnce(env);
  expect(state(UNROUTED), "no_route", "6 unsupported route");
  expect(state(), "submitted", "6 AERO send");
  await rpc("anvil_mine", ["0x80"]);
  await runOnce(env);
  expect(state(), "finalized", "6 after reconcile");

  const usdcAfter = await balanceOf(USDC, wallet);
  const aeroAfter = await balanceOf(AERO, wallet);
  const rows = sqlite
    .query(
      `SELECT state, amount_in, quote_amount_out, min_amount_out, amount_out,
              approval_tx_id, tx_id, evm_nonce, token_balance_before, target_balance_before,
              target_balance_after, reason FROM fee_conversions ORDER BY rowid`,
    )
    .all() as { state: string; amount_out: string | null }[];
  console.log(JSON.stringify(rows, null, 2));
  const recorded = rows.reduce(
    (sum, row) => sum + BigInt(row.amount_out ?? "0"),
    0n,
  );
  console.log(
    `USDC delta ${usdcAfter - usdcBefore}; recorded ${recorded}; AERO left ${aeroAfter}`,
  );
  if (
    JSON.stringify(rows.map((row) => row.state)) !==
      JSON.stringify([
        "finalized",
        "finalized",
        "finalized",
        "skipped",
        "failed",
        "finalized",
        "no_route",
      ]) ||
    recorded !== usdcAfter - usdcBefore ||
    aeroAfter !== 0n
  )
    throw new Error("fork live cycles did not finalize with matching proceeds");
  // A repeat run finds nothing left to sell and records nothing new.
  await runOnce(env);
  const count = sqlite
    .query("SELECT COUNT(*) AS n FROM fee_conversions")
    .get() as { n: number };
  if (count.n !== 7) throw new Error("a repeat run added a record");
  console.log(
    "PASS: Base fork live cycles (ordinary, lost send, lost response, below minimum, slippage refusal, unsupported route)",
  );
} finally {
  anvil.kill();
}
