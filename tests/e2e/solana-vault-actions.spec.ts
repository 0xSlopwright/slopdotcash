/** Real local validator and public fixture wallets. No live RPC or funds. */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { handlePaymentsApi } from "../../backend/payments/handler";
import type { SolanaEscrowConfig } from "../../contracts/solana/adapter";
import { decodeBase58Bytes } from "../../src/lib/base58";
import type { EscrowDeployment } from "../../src/lib/escrow-policy.mjs";
import { PROJECTS } from "../../src/lib/projects.mjs";

// Dependencies are installed by the existing Solana contract test command.
const requireSolana = createRequire(
  new URL("../../contracts/solana/package.json", import.meta.url),
);
const enabled = process.env.SLOP_E2E_SOLANA_VAULT === "1";
const anchor = enabled ? requireSolana("@coral-xyz/anchor") : null;
const web3 = enabled ? requireSolana("@solana/web3.js") : null;
const spl = enabled ? requireSolana("@solana/spl-token") : null;
const root = fileURLToPath(new URL("../..", import.meta.url));
const rpcUrl = "http://127.0.0.1:18989";
const hash = (text: string) => createHash("sha256").update(text).digest();
const owner = enabled
  ? web3.Keypair.fromSeed(hash("slop-browser-local-owner"))
  : null;
const donor = enabled
  ? web3.Keypair.fromSeed(hash("slop-browser-local-donor"))
  : null;
const identity = enabled
  ? web3.Keypair.fromSeed(hash("slop-browser-local-identity"))
  : null;
const fee = enabled
  ? web3.Keypair.fromSeed(hash("slop-browser-local-fee"))
  : null;
const connection = enabled ? new web3.Connection(rpcUrl, "confirmed") : null;
let validator: ChildProcess;
let deployment: EscrowDeployment;
let config: SolanaEscrowConfig;
let project: (typeof PROJECTS)[number];

test.skip(
  process.env.SLOP_E2E_SOLANA_VAULT !== "1",
  "Requires the explicit local Solana validator workflow run.",
);
test.describe.configure({ mode: "serial", timeout: 180_000 });
test.use({ actionTimeout: 15_000 });
test.beforeAll(async ({ browserName }, info) => {
  const idl = JSON.parse(
    readFileSync(`${root}/contracts/solana/idl/slop_escrow.json`, "utf8"),
  );
  const programId = new web3.PublicKey(idl.address);
  const binary = `${root}/contracts/solana/target/deploy/slop_escrow.so`;
  validator = spawn(
    "solana-test-validator",
    [
      "--reset",
      "--quiet",
      "--ledger",
      info.outputPath(`validator-ledger-${browserName}`),
      "--rpc-port",
      "18989",
      "--faucet-port",
      "19040",
      "--dynamic-port-range",
      "19001-19030",
      "--upgradeable-program",
      idl.address,
      binary,
      owner.publicKey.toBase58(),
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      await connection.getVersion();
      break;
    } catch {
      if (validator.exitCode !== null || i === 59)
        throw new Error("Local validator startup failed");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const airdrop = await connection.requestAirdrop(
    owner.publicKey,
    100 * web3.LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(airdrop, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(owner),
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl, provider);
  const pda = (...seeds: Buffer[]) =>
    web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
  const configPda = pda(Buffer.from("config"));
  const programData = web3.PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    new web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  )[0];
  await program.methods
    .initializeConfig(identity.publicKey, fee.publicKey)
    .accountsStrict({
      authority: owner.publicKey,
      config: configPda,
      program: programId,
      programData,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();
  const mint = await spl.createMint(
    connection,
    owner,
    owner.publicKey,
    null,
    6,
  );
  const digest = hash("slop-browser-local-project");
  const domain = hash("slop-browser-local-domain");
  const projectPda = pda(
    Buffer.from("project"),
    owner.publicKey.toBuffer(),
    digest,
  );
  const vault = pda(Buffer.from("vault"), projectPda.toBuffer());
  const initialized = await program.methods
    .initialize(
      [...digest],
      [...domain],
      identity.publicKey,
      fee.publicKey,
      new anchor.BN(3600),
      new anchor.BN(7200),
    )
    .accountsStrict({
      owner: owner.publicKey,
      project: projectPda,
      mint,
      vault,
      tokenProgram: spl.TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
      config: configPda,
    })
    .rpc();
  await web3.sendAndConfirmTransaction(
    connection,
    new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: donor.publicKey,
        lamports: web3.LAMPORTS_PER_SOL,
      }),
    ),
    [owner],
  );
  const source = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    owner,
    mint,
    donor.publicKey,
  );
  const minted = await spl.mintTo(
    connection,
    owner,
    mint,
    source.address,
    owner,
    100_000_000n,
  );
  await connection.confirmTransaction(minted, "finalized");
  deployment = {
    network: "solana-devnet",
    vault: vault.toBase58(),
    asset: mint.toBase58(),
    owner: owner.publicKey.toBase58(),
    identityAuthority: identity.publicKey.toBase58(),
    feeRecipient: fee.publicKey.toBase58(),
    programId: idl.address,
    projectPda: projectPda.toBase58(),
    networkDomain: domain.toString("hex"),
    upgradeAuthority: owner.publicKey.toBase58(),
    bindingDelaySeconds: "3600",
    rotationDelaySeconds: "7200",
    factory: null,
    registrar: null,
    factoryCodeSha256: null,
    deploymentTransaction: initialized,
    sourceCommit: "a".repeat(40),
    codeSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  };
  config = {
    ...deployment,
    projectId: "eliza",
    mint: deployment.asset,
    rpcUrl,
    genesisHash: await connection.getGenesisHash(),
  } as SolanaEscrowConfig;
  const original = PROJECTS.find((p) => p.id === "eliza");
  if (!original) throw new Error("Missing project fixture");
  project = {
    ...original,
    reward: {
      ...original.reward,
      chain: "solana",
      currency: "TEST",
      feeBasisPoints: 200,
      paymentMode: "disabled",
      committedMinor: "0",
      fundingState: "pledged",
    },
    rewardAsset: {
      network: "solana",
      kind: "token",
      address: deployment.asset,
      symbol: "TEST",
      decimals: 6,
      chainId: null,
      cluster: "mainnet-beta",
      verifiedAt: "2026-10-22T00:00:00.000Z",
    },
    escrow: {
      schemaVersion: "1",
      effectiveCycle: "2026-10",
      chain: "solana",
      feeBasisPoints: 200,
      withdrawalFeeBasisPoints: 200,
      feeMode: "deduct-from-gross",
      deployments: [deployment],
    },
  } as typeof project;
});
test.afterAll(async () => {
  if (validator && validator.exitCode === null) {
    const stopped = new Promise((resolve) => validator.once("exit", resolve));
    validator.kill("SIGTERM");
    await stopped;
  }
});

test("Solana wallet deposits, recovers after reload, and owner withdraws with verified fee", async ({
  page,
}, info) => {
  let selected = donor;
  let reject = false;
  let interrupted = false;
  const sends: string[] = [];
  const errors: string[] = [];
  const apiRejections: number[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("localSolanaAccount", () => ({
    address: selected.publicKey.toBase58(),
    publicKey: [...selected.publicKey.toBytes()],
  }));
  await page.exposeFunction(
    "localSolanaSend",
    async (wire: number[], address: string, chain: string) => {
      expect(chain).toBe("solana:devnet");
      expect(address).toBe(selected.publicKey.toBase58());
      if (reject) return { error: "rejected" };
      const transaction = web3.Transaction.from(Uint8Array.from(wire));
      transaction.sign(selected);
      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false, maxRetries: 0 },
      );
      sends.push(signature);
      return interrupted
        ? { error: "unknown" }
        : { signature: [...decodeBase58Bytes(signature)] };
    },
  );
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      localSolanaAccount(): Promise<{ address: string; publicKey: number[] }>;
      localSolanaSend(
        wire: number[],
        address: string,
        chain: string,
      ): Promise<{ error?: string; signature?: number[] }>;
    };
    let accounts: {
      address: string;
      publicKey: Uint8Array;
      chains: string[];
      features: string[];
    }[] = [];
    const wallet = {
      name: "Local Solana wallet",
      version: "1.0.0",
      icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E",
      chains: ["solana:devnet"],
      get accounts() {
        return accounts;
      },
      features: {
        "standard:connect": {
          version: "1.0.0",
          connect: async () => {
            const next = await bridge.localSolanaAccount();
            accounts = [
              {
                address: next.address,
                publicKey: Uint8Array.from(next.publicKey),
                chains: ["solana:devnet"],
                features: [
                  "solana:signMessage",
                  "solana:signAndSendTransaction",
                ],
              },
            ];
            return { accounts };
          },
        },
        "solana:signMessage": {
          version: "1.0.0",
          signMessage: async () => {
            throw new Error("Funding must not request an account-link message");
          },
        },
        "solana:signAndSendTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy"],
          signAndSendTransaction: async ({
            transaction,
            account,
            chain,
          }: {
            transaction: Uint8Array;
            account: { address: string };
            chain: string;
          }) => {
            const result = await bridge.localSolanaSend(
              [...transaction],
              account.address,
              chain,
            );
            if (result.error === "rejected")
              throw Object.assign(new Error("User rejected"), { code: 4001 });
            if (result.error)
              throw new Error("Transport interrupted after submission");
            return [{ signature: Uint8Array.from(result.signature ?? []) }];
          },
        },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (event) =>
      (event as CustomEvent).detail.register(wallet),
    );
  });
  await page.route(
    /\/(?:api\/v1\/projects|data\/fixture-project-registry\.json)$/,
    (route) =>
      route.fulfill({ json: { schemaVersion: "1", projects: [project] } }),
  );
  await page.route("**/api/v1/projects/eliza", (route) =>
    route.fulfill({ json: { project, revision: 1 } }),
  );
  await page.route("**/api/v1/project-session", (route) =>
    route.fulfill({ json: { session: null } }),
  );
  await page.route("**/api/v1/payments/projects/eliza/vault", (route) =>
    route.fulfill({
      json: {
        projectId: "eliza",
        snapshots: [],
        staleAfterMs: 60000,
        servedAt: new Date().toISOString(),
      },
    }),
  );
  await page.route(
    "**/api/v1/payments/projects/eliza/solana-funding",
    async (route) => {
      const response = await handlePaymentsApi(
        new Request(
          "https://slop.cash/api/v1/payments/projects/eliza/solana-funding",
          {
            method: "POST",
            headers: {
              origin: "https://slop.cash",
              "content-type": "application/json",
            },
            body: route.request().postData(),
          },
        ),
        {
          db: {
            prepare() {
              throw new Error("No Slop login is required for funding");
            },
          } as never,
          solanaFundingConfig: async (id, network, vault) => {
            expect(id).toBe("eliza");
            expect(network).toBe(deployment.network);
            expect(vault).toBe(deployment.vault);
            return config;
          },
        },
      );
      if (!response.ok) apiRejections.push(response.status);
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: await response.text(),
      });
    },
  );
  await page.goto("/projects/eliza/funding", { waitUntil: "networkidle" });
  const actions = page.getByRole("region", {
    name: "Fund or withdraw · solana-devnet",
    exact: true,
  });
  const connect = () =>
    actions
      .getByRole("button", { name: "Connect Local Solana wallet", exact: true })
      .click();
  await connect();
  await actions.getByLabel("Token amount", { exact: true }).fill("101");
  await actions
    .getByRole("button", { name: "Review deposit", exact: true })
    .click();
  await expect(actions.getByRole("alert")).toContainText("balance is too low");
  await actions.getByLabel("Token amount", { exact: true }).fill("10");
  await actions
    .getByRole("button", { name: "Review deposit", exact: true })
    .click();
  await expect(
    actions.getByRole("region", { name: "Review vault action" }),
  ).toContainText("no refund right");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: info.outputPath("solana-deposit-review.png"),
    fullPage: true,
  });
  reject = true;
  await actions
    .getByRole("button", { name: "Confirm deposit in wallet", exact: true })
    .click();
  await expect(actions.getByRole("alert")).toContainText("You declined");
  expect(sends).toHaveLength(0);
  reject = false;
  interrupted = true;
  await actions
    .getByRole("button", { name: "Confirm deposit in wallet", exact: true })
    .click();
  await expect(actions.getByRole("alert")).toContainText(
    "wallet result is unclear",
  );
  await page.reload({ waitUntil: "networkidle" });
  await connect();
  await expect(
    actions.getByRole("button", {
      name: "Confirm deposit in wallet",
      exact: true,
    }),
  ).toHaveCount(0);
  await actions
    .getByLabel("Transaction signature from your wallet")
    .fill("1".repeat(64));
  await actions
    .getByRole("button", { name: "Check transaction", exact: true })
    .click();
  await expect(actions.getByRole("alert")).toContainText(
    "does not match the pending wallet action",
  );
  await actions
    .getByLabel("Transaction signature from your wallet")
    .fill(sends[0]);
  await connection.confirmTransaction(sends[0], "finalized");
  await actions
    .getByRole("button", { name: "Check transaction", exact: true })
    .click();
  await expect(actions.getByRole("status")).toContainText("Deposit verified");
  await actions
    .getByRole("radio", {
      name: "Withdraw free funds (owner only)",
      exact: true,
    })
    .check();
  await actions
    .getByRole("button", { name: "Review withdrawal", exact: true })
    .click();
  await expect(actions.getByRole("alert")).toContainText(
    "Only the vault owner's wallet",
  );
  selected = owner;
  interrupted = false;
  await actions.getByRole("button", { name: "Choose another wallet" }).click();
  await connect();
  await actions.getByLabel("Token amount", { exact: true }).fill("5");
  await actions
    .getByRole("button", { name: "Review withdrawal", exact: true })
    .click();
  await expect(
    actions.getByRole("region", { name: "Review vault action" }),
  ).toContainText("4.9");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: info.outputPath("solana-withdrawal-review.png"),
    fullPage: true,
  });
  await actions
    .getByRole("button", { name: "Confirm withdrawal in wallet", exact: true })
    .click();
  await expect.poll(() => sends.length).toBe(2);
  await connection.confirmTransaction(sends[1], "finalized");
  await actions
    .getByRole("button", { name: "Check transaction", exact: true })
    .click();
  await expect(actions.getByRole("status")).toContainText(
    "Withdrawal verified",
  );
  const account = await spl.getAccount(
    connection,
    spl.getAssociatedTokenAddressSync(
      new web3.PublicKey(deployment.asset),
      owner.publicKey,
    ),
  );
  expect(account.amount).toBe(4_900_000n);
  expect(apiRejections).toEqual([422, 422, 422]);
  expect(errors).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});
