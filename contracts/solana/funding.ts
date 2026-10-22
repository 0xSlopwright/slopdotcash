import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeBase58Bytes } from "../../src/lib/base58";
import {
  readVaultTotals,
  type SolanaEscrowConfig,
  solanaPubkey,
  solanaRpc,
  solanaUint,
  solanaVaultAddress,
  verifySolanaDeployment,
} from "./adapter";
import {
  ata,
  bytes,
  concat,
  createAta,
  type Instruction,
  instructionData,
  le,
  message,
  TOKEN,
} from "./transactions";

export class SolanaFundingError extends Error {}

export type SolanaFundingDeployment = Pick<
  SolanaEscrowConfig,
  "programId" | "projectPda" | "vault" | "mint" | "owner" | "feeRecipient"
>;

export interface SolanaFundingIntent {
  operation: "deposit" | "withdraw";
  wallet: string;
  gross: string;
  blockhash: string;
}
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const decode = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SolanaFundingError("Invalid chain response");
  return value as Record<string, unknown>;
}
function baseAmount(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > (1n << 64n) - 1n)
    throw new SolanaFundingError(
      "The amount is outside the Solana vault's supported range.",
    );
  return BigInt(value);
}
/** Same accounts and instruction order as the reviewed owner planner. */
function fundingInstructions(
  config: SolanaFundingDeployment,
  intent: Omit<SolanaFundingIntent, "blockhash">,
): Instruction[] {
  bytes(intent.wallet);
  const gross = baseAmount(intent.gross);
  if (solanaVaultAddress(config.programId, config.projectPda) !== config.vault)
    throw new SolanaFundingError("The vault does not belong to this project.");
  if (intent.operation !== "deposit" && intent.operation !== "withdraw")
    throw new SolanaFundingError("Unknown vault action.");
  if (intent.operation === "withdraw" && intent.wallet !== config.owner)
    throw new SolanaFundingError(
      "Only the vault owner's wallet can withdraw free funds.",
    );
  const accounts = [
    { key: intent.wallet, write: true },
    { key: config.projectPda, write: true },
    { key: config.mint, write: false },
    {
      key:
        intent.operation === "deposit"
          ? ata(config.mint, intent.wallet)
          : config.vault,
      write: true,
    },
    {
      key:
        intent.operation === "deposit"
          ? config.vault
          : ata(config.mint, intent.wallet),
      write: true,
    },
  ];
  if (intent.operation === "withdraw")
    accounts.push({ key: ata(config.mint, config.feeRecipient), write: true });
  accounts.push({ key: TOKEN, write: false });
  const action = {
    program: config.programId,
    accounts,
    data: instructionData(intent.operation, le(gross)),
  };
  return intent.operation === "deposit"
    ? [action]
    : [
        createAta(intent.wallet, config.mint, config.owner),
        createAta(intent.wallet, config.mint, config.feeRecipient),
        action,
      ];
}
export function solanaFundingMessage(
  config: SolanaFundingDeployment,
  intent: SolanaFundingIntent,
): Uint8Array {
  return message(
    intent.wallet,
    intent.blockhash,
    fundingInstructions(config, intent),
  );
}

/** Explicit review only. No key, signature or send RPC is available through this planner. */
export async function prepareSolanaFunding(
  config: SolanaEscrowConfig,
  intent: Omit<SolanaFundingIntent, "blockhash">,
) {
  const instructions = fundingInstructions(config, intent);
  await verifySolanaDeployment(config);
  const totals = await readVaultTotals(config);
  if (totals.asset !== config.mint)
    throw new SolanaFundingError("The vault asset changed.");
  const gross = baseAmount(intent.gross);
  if (intent.operation === "withdraw") {
    if (totals.freeBalance === null || gross > BigInt(totals.freeBalance))
      throw new SolanaFundingError(
        "The amount exceeds the vault's free balance. Reserved awards cannot be withdrawn.",
      );
  } else {
    const response = object(
      await solanaRpc(config, "getAccountInfo", [
        ata(config.mint, intent.wallet),
        { commitment: "finalized", encoding: "base64" },
      ]),
    );
    if (!response.value)
      throw new SolanaFundingError(
        "Your wallet has no token account for this deposit.",
      );
    const source = object(response.value);
    if (
      source.owner !== TOKEN ||
      !Array.isArray(source.data) ||
      source.data[1] !== "base64" ||
      typeof source.data[0] !== "string"
    )
      throw new SolanaFundingError(
        "The deposit token account could not be verified.",
      );
    const data = decode(source.data[0]);
    if (
      data.length !== 165 ||
      solanaPubkey(data, 0) !== config.mint ||
      solanaPubkey(data, 32) !== intent.wallet ||
      data[108] !== 1
    )
      throw new SolanaFundingError(
        "The deposit token account is unavailable or frozen.",
      );
    if (solanaUint(data, 64) < gross)
      throw new SolanaFundingError(
        "Your token balance is too low for this deposit.",
      );
  }
  const latest = object(
    object(
      await solanaRpc(config, "getLatestBlockhash", [
        { commitment: "finalized" },
      ]),
    ).value,
  );
  if (
    typeof latest.blockhash !== "string" ||
    !Number.isSafeInteger(latest.lastValidBlockHeight)
  )
    throw new SolanaFundingError(
      "The chain did not return a valid transaction lifetime.",
    );
  const msg = message(intent.wallet, latest.blockhash, instructions);
  const wire = encode(concat(Uint8Array.of(1), new Uint8Array(64), msg));
  const feeResult = object(
    await solanaRpc(config, "getFeeForMessage", [
      encode(msg),
      { commitment: "finalized" },
    ]),
  );
  if (!Number.isSafeInteger(feeResult.value) || Number(feeResult.value) < 0)
    throw new SolanaFundingError(
      "The network fee could not be calculated. Review again.",
    );
  const native = object(
    await solanaRpc(config, "getBalance", [
      intent.wallet,
      { commitment: "finalized" },
    ]),
  );
  if (
    !Number.isSafeInteger(native.value) ||
    Number(native.value) < Number(feeResult.value)
  )
    throw new SolanaFundingError("Your wallet needs SOL for the network fee.");
  const simulation = object(
    object(
      await solanaRpc(config, "simulateTransaction", [
        wire,
        { encoding: "base64", sigVerify: false, commitment: "finalized" },
      ]),
    ).value,
  );
  if (simulation.err !== null)
    throw new SolanaFundingError(
      "This action could not be simulated. Check the token balance and SOL for network fees and account rent, then review again.",
    );
  const fee = intent.operation === "withdraw" ? gross / 50n : 0n;
  return {
    ...intent,
    blockhash: latest.blockhash,
    lastValidBlockHeight: Number(latest.lastValidBlockHeight),
    transaction: wire,
    gross: gross.toString(),
    fee: fee.toString(),
    net: (gross - fee).toString(),
    decimals: totals.decimals,
    freeBalance: totals.freeBalance,
    networkFeeLamports: String(feeResult.value),
  };
}

/** A pasted ID is accepted only for this exact wallet action, finalized with reconciled token deltas. */
export async function checkSolanaFunding(
  config: SolanaEscrowConfig,
  intent: SolanaFundingIntent,
  transactionId: string,
) {
  const signature = decodeBase58Bytes(transactionId);
  if (signature.length !== 64)
    throw new SolanaFundingError(
      "Enter a Solana transaction signature from your wallet.",
    );
  const msg = solanaFundingMessage(config, intent);
  if (!ed25519.verify(signature, msg, bytes(intent.wallet), { zip215: false }))
    throw new SolanaFundingError(
      "This transaction does not match the pending wallet action. Check its signature in your wallet.",
    );
  await verifySolanaDeployment(config);
  const response = object(
    await solanaRpc(config, "getSignatureStatuses", [
      [transactionId],
      { searchTransactionHistory: true },
    ]),
  );
  if (!Array.isArray(response.value) || response.value.length !== 1)
    throw new SolanaFundingError("Invalid transaction status response.");
  if (response.value[0] === null) return "pending";
  const status = object(response.value[0]);
  if (status.confirmationStatus !== "finalized") return "pending";
  const raw = await solanaRpc(config, "getTransaction", [
    transactionId,
    {
      encoding: "base64",
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (!raw) return "pending";
  const tx = object(raw);
  if (
    !Number.isSafeInteger(tx.slot) ||
    tx.slot !== status.slot ||
    !Array.isArray(tx.transaction) ||
    tx.transaction[1] !== "base64" ||
    typeof tx.transaction[0] !== "string"
  )
    throw new SolanaFundingError(
      "The finalized transaction could not be verified.",
    );
  const wire = decode(tx.transaction[0]);
  const expected = concat(Uint8Array.of(1), signature, msg);
  if (
    wire.length !== expected.length ||
    wire.some((byte, index) => byte !== expected[index])
  )
    throw new SolanaFundingError(
      "The finalized transaction differs from the reviewed action.",
    );
  const meta = object(tx.meta);
  if (meta.err !== null) return "failed";
  if (status.err !== null)
    throw new SolanaFundingError(
      "Finalized transaction status disagrees with its receipt.",
    );
  // The compiled message is already exact. Its compact account count fits one byte
  // because the shared encoder permits at most 32 accounts.
  const accountCount = msg[3];
  const keys = Array.from({ length: accountCount }, (_, index) =>
    solanaPubkey(msg, 4 + index * 32),
  );
  function balances(value: unknown): Map<string, bigint> {
    if (!Array.isArray(value))
      throw new SolanaFundingError("Finalized token balances are missing.");
    const result = new Map<string, bigint>();
    for (const item of value) {
      const entry = object(item);
      if (entry.mint !== config.mint) continue;
      const index = Number(entry.accountIndex);
      const amount = object(entry.uiTokenAmount).amount;
      if (
        !Number.isSafeInteger(index) ||
        !keys[index] ||
        typeof amount !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(amount) ||
        result.has(keys[index])
      )
        throw new SolanaFundingError("Finalized token balances are invalid.");
      result.set(keys[index], BigInt(amount));
    }
    return result;
  }
  const before = balances(meta.preTokenBalances),
    after = balances(meta.postTokenBalances);
  const deltas = new Map<string, bigint>();
  const add = (key: string, value: bigint) =>
    deltas.set(key, (deltas.get(key) ?? 0n) + value);
  const gross = baseAmount(intent.gross);
  if (intent.operation === "deposit") {
    add(config.vault, gross);
    add(ata(config.mint, intent.wallet), -gross);
  } else {
    const fee = gross / 50n;
    add(config.vault, -gross);
    add(ata(config.mint, config.owner), gross - fee);
    add(ata(config.mint, config.feeRecipient), fee);
  }
  for (const [key, delta] of deltas) {
    if (
      !after.has(key) ||
      (after.get(key) ?? 0n) - (before.get(key) ?? 0n) !== delta
    )
      throw new SolanaFundingError(
        "Finalized token movements do not match this action.",
      );
  }
  return "finalized";
}
