/**
 * Local-only workflow: the payments Worker finds a vault through the D1
 * project registry and writes its finalized counters to vault_snapshots.
 * Real escrow contracts run on Anvil with the Base Sepolia chain id; the
 * registry tables, triggers and revisions are the real migrations. The
 * readiness report then reads the same registry and probes the same RPC.
 */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "../../backend/trace/cloudflare-persistence";
import {
  payoutReadiness,
  probeRpc,
} from "../../scripts/check-payout-readiness";
import { paymentDeploymentRecord } from "../../src/lib/escrow-policy.mjs";
import { assertProjectDefinition } from "../../src/lib/project-schema.mjs";
import { registryDeployments, syncRegistryVaults } from "./index";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = 18571;
const rpcUrl = `http://127.0.0.1:${port}`;
// Anvil's public deterministic accounts 0, 1 and 2; no user key is read.
const registrar = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const attester = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const owner = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const fee = "0x0000000000000000000000000000000000000fee";
const delay = "3600";
const projectKey = `0x${"1".padStart(64, "0")}`;

const anvil = spawn(
  "anvil",
  ["--port", String(port), "--chain-id", "84532", "--silent"],
  { stdio: "ignore" },
);
const sql = new Database(":memory:");
function statement(
  query: string,
  args: unknown[] = [],
): ReturnType<D1Database["prepare"]> {
  return {
    bind: (...values: unknown[]) => statement(query, values),
    async first<T>() {
      return (sql.prepare(query).get(...(args as string[])) ??
        null) as T | null;
    },
    async run() {
      const result = sql.prepare(query).run(...(args as string[]));
      return { success: true, meta: { changes: result.changes } };
    },
  };
}
const db: D1Database = {
  prepare: statement,
  async batch(statements) {
    const results = [];
    for (const item of statements) results.push(await item.run());
    return results;
  },
};
async function rpc(method: string, params: unknown[]) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
function deploy(contract: string, args: string[] = []) {
  return JSON.parse(
    execFileSync(
      "forge",
      [
        "create",
        "--root",
        `${root}contracts/evm`,
        contract,
        "--rpc-url",
        rpcUrl,
        "--unlocked",
        "--from",
        registrar,
        "--broadcast",
        "--json",
        ...(args.length ? ["--constructor-args", ...args] : []),
      ],
      { encoding: "utf8" },
    ),
  ) as { deployedTo: string; transactionHash: string };
}
async function send(to: string, signature: string, args: string[]) {
  const data = execFileSync("cast", ["calldata", signature, ...args], {
    encoding: "utf8",
  }).trim();
  const hash = (await rpc("eth_sendTransaction", [
    { from: registrar, to, data, gas: "0x7a1200" },
  ])) as string;
  await rpc("anvil_mine", ["0x1"]);
  const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as {
    status: string;
  };
  assert.equal(receipt.status, "0x1", `Transaction failed: ${signature}`);
  return hash;
}
const codeSha256 = async (address: string) =>
  createHash("sha256")
    .update(
      Buffer.from(
        ((await rpc("eth_getCode", [address, "latest"])) as string).slice(2),
        "hex",
      ),
    )
    .digest("hex");
/** Appends one revision and moves the project pointer, as the admin API does. */
function appendRevision(
  manifest: { id: string; status: string },
  revision: number,
) {
  const text = JSON.stringify(manifest);
  const digest = createHash("sha256").update(text).digest("hex");
  const at = new Date().toISOString();
  sql
    .prepare(
      "INSERT INTO project_revisions(project_id,revision,manifest,manifest_sha256,reason,actor_github_id,actor_github_login,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      manifest.id,
      revision,
      text,
      digest,
      revision === 1 ? "Approved application" : "Record escrow deployment",
      "900000001",
      "e2e-admin",
      at,
    );
  if (revision === 1)
    sql
      .prepare(
        "INSERT INTO projects(id,status,revision,manifest,manifest_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(manifest.id, manifest.status, 1, text, digest, at, at);
  else
    sql
      .prepare(
        "UPDATE projects SET revision=?,manifest=?,manifest_sha256=?,status=?,updated_at=? WHERE id=?",
      )
      .run(revision, text, digest, manifest.status, at, manifest.id);
}

try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    if (anvil.exitCode !== null) throw new Error("Anvil startup failed");
    try {
      await rpc("eth_chainId", []);
      ready = true;
    } catch {
      await Bun.sleep(50);
    }
  }
  assert(ready, "Anvil startup");
  for (const file of readdirSync(`${root}migrations`)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(`${root}migrations/${file}`, "utf8"));

  const asset = deploy("integration/TestDollar.sol:TestDollar").deployedTo;
  const factory = deploy("src/ProjectEscrow.sol:EscrowFactory", [
    registrar,
    fee,
    attester,
    delay,
  ]).deployedTo;
  const createTx = await send(
    factory,
    "create(bytes32,address,address,address)",
    [projectKey, asset, owner, owner],
  );
  const vault = `0x${(
    (await rpc("eth_call", [
      {
        to: factory,
        data: `0x4627e7c0${projectKey.slice(2)}${asset.slice(2).toLowerCase().padStart(64, "0")}`,
      },
      "latest",
    ])) as string
  )
    .slice(-40)
    .toLowerCase()}`;
  await send(asset, "mint(address,uint256)", [registrar, "250000000"]);
  await send(asset, "approve(address,uint256)", [vault, "250000000"]);
  await send(vault, "deposit(uint128)", ["250000000"]);
  // The worker reads at the finalized tag, so let the deposit finalize.
  await rpc("anvil_mine", ["0x40"]);

  const fixture = JSON.parse(
    readFileSync(`${root}tests/fixtures/projects/eliza.json`, "utf8"),
  );
  const base = {
    ...fixture,
    reward: {
      ...fixture.reward,
      chain: "base",
      currency: "USDC",
      feeBasisPoints: 200,
    },
  };
  const deployment = {
    network: "base-sepolia" as const,
    vault,
    programId: null,
    upgradeAuthority: null,
    projectPda: null,
    networkDomain: null,
    asset: asset.toLowerCase(),
    owner,
    identityAuthority: attester,
    feeRecipient: fee,
    deploymentTransaction: createTx,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    codeSha256: await codeSha256(vault),
    bindingDelaySeconds: delay,
    rotationDelaySeconds: null,
    factory: factory.toLowerCase(),
    factoryCodeSha256: await codeSha256(factory),
    registrar,
  };
  const withEscrow = assertProjectDefinition({
    ...base,
    escrow: {
      schemaVersion: "1",
      effectiveCycle: "2026-11",
      chain: "base",
      feeBasisPoints: 200,
      withdrawalFeeBasisPoints: 500,
      feeMode: "deduct-from-gross",
      deployments: [deployment],
    },
  });
  const { escrow: _escrow, ...withoutEscrow } = withEscrow;

  const env = {
    PAYMENTS_DB: db,
    PAYMENT_NETWORKS: JSON.stringify(["base-sepolia"]),
    PAYMENT_RPC_URLS: JSON.stringify({ "base-sepolia": rpcUrl }),
  };
  const snapshots = () =>
    sql
      .query("SELECT * FROM vault_snapshots ORDER BY project_id")
      .all() as Record<string, unknown>[];

  // 1. A project without a recorded deployment has no vault to read.
  appendRevision(withoutEscrow, 1);
  const before = await syncRegistryVaults(env);
  assert.deepEqual(before.deployments, []);
  assert.deepEqual(before.failures, []);
  assert.deepEqual(snapshots(), []);

  // 2. An admin revision records the deployment. The next run finds the vault
  //    without any Worker configuration change.
  appendRevision(withEscrow, 2);
  const found = await syncRegistryVaults(env);
  assert.deepEqual(found.failures, [], String(found.failures));
  assert.deepEqual(found.deployments, [
    paymentDeploymentRecord("eliza", deployment),
  ]);
  const [row] = snapshots();
  assert.equal(row.project_id, "eliza");
  assert.equal(row.network, "base-sepolia");
  assert.equal(row.chain, "base");
  assert.equal(row.vault, vault);
  assert.equal(row.total_deposited, "250000000");
  assert.equal(row.free_balance, "250000000");
  assert.equal(row.total_paid, "0");
  assert.equal(row.asset_decimals, 6);
  const finalized = (await rpc("eth_getBlockByNumber", [
    "finalized",
    false,
  ])) as {
    number: string;
  };
  assert.equal(row.block_number, BigInt(finalized.number).toString());
  const cursor = sql
    .query(
      "SELECT position FROM payment_chain_cursors WHERE project_id='eliza' AND network='base-sepolia'",
    )
    .get() as { position: string } | null;
  assert.equal(
    cursor?.position,
    BigInt(finalized.number).toString(),
    "The finalized event scan covered the vault up to the finalized head",
  );

  // 3. A Worker serving another network does not read this vault, and a
  //    Worker without a valid network list stops instead of guessing.
  assert.deepEqual(
    (
      await registryDeployments({
        ...env,
        PAYMENT_NETWORKS: JSON.stringify(["robinhood-testnet"]),
      })
    ).deployments,
    [],
  );
  for (const value of [
    "",
    "[]",
    '["base-sepolia","base-sepolia"]',
    '["anvil"]',
  ])
    await assert.rejects(
      syncRegistryVaults({ ...env, PAYMENT_NETWORKS: value }),
      /PAYMENT_NETWORKS/,
    );

  // 4. One corrupted manifest is reported and never hides the other vaults.
  sql.exec("DROP TRIGGER projects_match_revision_insert");
  sql
    .prepare(
      "INSERT INTO projects(id,status,revision,manifest,manifest_sha256,created_at,updated_at) VALUES('broken','paused',1,?,?,?,?)",
    )
    .run(
      JSON.stringify({
        id: "broken",
        status: "paused",
        escrow: { ...withEscrow.escrow, feeBasisPoints: 100 },
      }),
      "0".repeat(64),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const partial = await syncRegistryVaults(env);
  assert.equal(partial.deployments.length, 1);
  assert.equal(partial.failures.length, 1);
  assert.match(String(partial.failures[0]), /Project broken escrow/);

  // 5. The readiness report: the probe proves the Base Sepolia chain id and
  //    a finalized head, and a mainnet stays off by review.
  assert.equal(await probeRpc("base-sepolia", rpcUrl), "finalized");
  assert.equal(await probeRpc("base-mainnet", rpcUrl), "wrong-chain");
  const record = paymentDeploymentRecord("eliza", deployment);
  const signer = (role: string) => ({
    vars: {
      SIGNER_ROLE: role,
      CHAIN_FAMILY: "evm",
      PAYMENT_DEPLOYMENTS: JSON.stringify([record]),
    },
  });
  const dispatcher = {
    vars: { PAYMENT_NETWORKS: env.PAYMENT_NETWORKS },
    services: [{ binding: "EVM_PAYMENT_EXECUTOR", service: "relayer" }],
  };
  const report = (configs: object[], rpcUrls: Record<string, string>) =>
    payoutReadiness({
      registry: [withEscrow],
      configs,
      rpcUrls,
      probes: { "base-sepolia": "finalized" },
    });
  const complete = report([signer("attester"), signer("relayer"), dispatcher], {
    "base-sepolia": "https://base-sepolia.rpc.example",
  });
  const sepolia = complete.find((item) => item.network === "base-sepolia");
  assert.deepEqual(sepolia, {
    network: "base-sepolia",
    testnet: true,
    deployments: 1,
    factory: "configured",
    attester: "configured",
    rpc: "finalized",
    executor: "enabled",
    ready: true,
    reasons: [],
  });
  for (const item of complete.filter(
    (entry) => entry.network !== "base-sepolia",
  ))
    assert.equal(item.ready, false, `${item.network} has no stack`);
  const mainnet = report(
    [signer("attester"), signer("relayer"), dispatcher],
    {},
  ).find((item) => item.network === "base-mainnet");
  assert.equal(mainnet?.executor, "off-by-review");
  assert(
    mainnet?.reasons.includes("MAINNET_EXECUTION is off for this network"),
  );
  const noAttester = report([signer("relayer"), dispatcher], {
    "base-sepolia": "http://plain-text.example",
  }).find((item) => item.network === "base-sepolia");
  assert.equal(noAttester?.attester, "missing");
  assert.equal(noAttester?.rpc, "missing");
  assert.equal(noAttester?.ready, false);
  console.log(
    `registry vault discovery: snapshot block ${row.block_number}, deposited ${row.total_deposited}; readiness ${sepolia?.ready ? "ready" : "not ready"} for base-sepolia`,
  );
} finally {
  anvil.kill();
  sql.close();
}
