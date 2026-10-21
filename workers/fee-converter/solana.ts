/**
 * Solana fee-wallet client. Routes come from the Jupiter Swap API. Each
 * Jupiter transaction is parsed before signing: the fee wallet is the only
 * signer and fee payer, every top-level program is on a short allowlist, and
 * a simulation must credit the fee wallet's USDC account with at least the
 * signed minimum.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { solanaBase58 } from "../../contracts/solana/adapter";
import { decodeBase58Bytes } from "../../src/lib/base58";
import type { Limits, NetworkConfig } from "./config";
import type {
  ChainClient,
  ConversionRow,
  PreparedSend,
  Quote,
  QuoteResult,
  SendStatus,
} from "./core";

export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/**
 * Top-level programs a conversion may invoke: compute budget, idempotent
 * associated-account creation and the Jupiter router. System and token
 * programs never run at top level, so no direct transfer can be added.
 */
const ALLOWED_PROGRAMS = new Set([
  COMPUTE_BUDGET,
  ASSOCIATED_TOKEN,
  JUPITER_PROGRAM,
]);

type Fetch = typeof fetch;

export interface SolanaClientOptions {
  config: NetworkConfig;
  limits: Limits;
  jupiterApiUrl: string;
  jupiterApiKey: string | null;
  /** Solana CLI keypair JSON (64 numbers). Absent in dry_run. */
  keypair?: string;
  fetch?: Fetch;
  /**
   * Local validator tests only: re-stamp the Jupiter message with the local
   * blockhash before signing. The hosted Worker never sets this.
   */
  localBlockhash?: boolean;
}

function compactLength(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  for (let shift = 0, i = 0; i < 3; i++, shift += 7) {
    const byte = bytes[offset + i];
    if (byte === undefined) throw new Error("truncated transaction");
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset + i + 1];
  }
  throw new Error("invalid compact length");
}

export interface ParsedTransaction {
  signatureCount: number;
  messageOffset: number;
  requiredSignatures: number;
  staticKeys: string[];
  blockhashOffset: number;
  programs: string[];
}

/** Parses a legacy or v0 wire transaction far enough to check its signers and programs. */
export function parseTransaction(raw: Uint8Array): ParsedTransaction {
  const [signatureCount, afterCount] = compactLength(raw, 0);
  const messageOffset = afterCount + signatureCount * 64;
  let offset = messageOffset;
  if ((raw[offset] & 0x80) !== 0) {
    if ((raw[offset] & 0x7f) !== 0)
      throw new Error("unsupported message version");
    offset += 1;
  }
  const requiredSignatures = raw[offset];
  offset += 3;
  const [keyCount, afterKeys] = compactLength(raw, offset);
  offset = afterKeys;
  const staticKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    staticKeys.push(solanaBase58(raw.slice(offset, offset + 32)));
    offset += 32;
  }
  const blockhashOffset = offset;
  offset += 32;
  const [instructionCount, afterInstructions] = compactLength(raw, offset);
  offset = afterInstructions;
  const programs: string[] = [];
  for (let i = 0; i < instructionCount; i++) {
    const programIndex = raw[offset];
    offset += 1;
    // Program ids must be static keys; a lookup-table index is refused.
    if (programIndex === undefined || programIndex >= staticKeys.length)
      throw new Error("program id outside the static keys");
    programs.push(staticKeys[programIndex]);
    const [accounts, afterAccounts] = compactLength(raw, offset);
    offset = afterAccounts + accounts;
    const [dataLength, afterData] = compactLength(raw, offset);
    offset = afterData + dataLength;
  }
  if (offset > raw.length) throw new Error("truncated transaction");
  return {
    signatureCount,
    messageOffset,
    requiredSignatures,
    staticKeys,
    blockhashOffset,
    programs,
  };
}

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAccount(
  owner: string,
  mint: string,
  tokenProgram = TOKEN_PROGRAM,
): string {
  const seeds = [owner, tokenProgram, mint].map(decodeBase58Bytes);
  const program = decodeBase58Bytes(ASSOCIATED_TOKEN);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, marker];
    const input = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      input.set(part, at);
      at += part.length;
    }
    const hash = sha256(input);
    if (!onCurve(hash)) return solanaBase58(hash);
  }
  throw new Error("no associated token address");
}

function decimalBps(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(String(value));
  if (!match) return null;
  // fraction * 10000, rounded up so a cap is never undercounted.
  const fraction = (match[2] ?? "").padEnd(4, "0");
  const whole = BigInt(match[1]) * 10_000n + BigInt(fraction.slice(0, 4));
  const rest = /[1-9]/u.test(fraction.slice(4)) ? 1n : 0n;
  return Number(whole + rest);
}

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  platformFee: unknown;
  routePlan?: { swapInfo?: { label?: string } }[];
}

export function createSolanaClient(
  options: SolanaClientOptions,
): ChainClient & {
  address(): string | null;
} {
  const { config, limits } = options;
  const doFetch = options.fetch ?? fetch;
  const wallet = config.feeWallet;
  const stablecoin = config.definition.stablecoin;
  const seed = options.keypair
    ? (() => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(options.keypair);
        } catch {
          throw new TypeError("Fee-wallet keypair for solana is malformed");
        }
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 64 ||
          !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
        )
          throw new TypeError("Fee-wallet keypair for solana is malformed");
        const bytes = Uint8Array.from(parsed);
        const secret = bytes.slice(0, 32);
        const publicKey = ed25519.getPublicKey(secret);
        if (
          solanaBase58(publicKey) !== wallet ||
          solanaBase58(bytes.slice(32)) !== wallet
        )
          throw new TypeError(
            "Fee-wallet keypair for solana does not control the configured fee wallet",
          );
        return secret;
      })()
    : null;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await doFetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as {
      result?: T;
      error?: { message?: string };
    };
    if (!response.ok || body.error)
      throw new Error(
        `Solana ${method}: ${String(body.error?.message ?? response.status).slice(0, 200)}`,
      );
    return body.result as T;
  }

  async function jupiter<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await doFetch(`${options.jupiterApiUrl}/${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(options.jupiterApiKey
          ? { "x-api-key": options.jupiterApiKey }
          : {}),
      },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail = body as { error?: string; errorCode?: string } | null;
      const error = new Error(
        `Jupiter ${path.split("?")[0]}: ${String(detail?.errorCode ?? detail?.error ?? response.status).slice(0, 200)}`,
      );
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return body as T;
  }

  async function fetchQuote(
    token: string,
    amount: bigint,
    slippageBps: number,
  ) {
    const quote = await jupiter<JupiterQuote>(
      `quote?${new URLSearchParams({
        inputMint: token,
        outputMint: stablecoin,
        amount: amount.toString(),
        slippageBps: String(slippageBps),
        swapMode: "ExactIn",
        restrictIntermediateTokens: "true",
      })}`,
    );
    if (
      quote.inputMint !== token ||
      quote.outputMint !== stablecoin ||
      quote.inAmount !== amount.toString() ||
      quote.swapMode !== "ExactIn" ||
      quote.platformFee !== null ||
      !/^\d+$/u.test(quote.outAmount) ||
      !/^\d+$/u.test(quote.otherAmountThreshold)
    )
      throw new Error("Jupiter quote does not match the request");
    return quote;
  }

  async function usdcBalance(account: string): Promise<bigint> {
    const result = await rpc<{ value: { amount: string } } | null>(
      "getTokenAccountBalance",
      [account, { commitment: "confirmed" }],
    ).catch((error: Error) => {
      if (/could not find account|Invalid param/iu.test(error.message))
        return null;
      throw error;
    });
    return result ? BigInt(result.value.amount) : 0n;
  }

  return {
    address: () => (seed ? wallet : null),

    async balance(token) {
      const result = await rpc<{
        value: {
          account: {
            data: { parsed: { info: { tokenAmount: { amount: string } } } };
          };
        }[];
      }>("getTokenAccountsByOwner", [
        wallet,
        { mint: token },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      return result.value.reduce(
        (sum, entry) =>
          sum + BigInt(entry.account.data.parsed.info.tokenAmount.amount),
        0n,
      );
    },

    async quote(token, amount): Promise<QuoteResult> {
      let quote: JupiterQuote;
      try {
        quote = await fetchQuote(token, amount, limits.maxSlippageBps);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500)
          return { noRoute: (error as Error).message };
        throw error;
      }
      const amountOut = BigInt(quote.outAmount);
      if (amountOut === 0n) return { noRoute: "Jupiter quoted zero output" };
      return {
        route: "jupiter",
        amountIn: amount,
        amountOut,
        minAmountOut: BigInt(quote.otherAmountThreshold),
        priceImpactBps: decimalBps(quote.priceImpactPct),
        gasCostMicro: limits.solanaFeeMicro,
        summary: {
          aggregator: "jupiter",
          slippageBps: quote.slippageBps,
          priceImpactPct: quote.priceImpactPct,
          venues: (quote.routePlan ?? [])
            .map((step) => step.swapInfo?.label)
            .filter((label): label is string => typeof label === "string")
            .slice(0, 8),
        },
      };
    },

    async prepare(token, quote: Quote): Promise<PreparedSend> {
      if (!seed)
        throw new Error("Signing is disabled without a fee-wallet key");
      const fresh = await fetchQuote(
        token,
        quote.amountIn,
        Math.max(1, Math.floor(limits.maxSlippageBps / 2)),
      );
      const minAmountOut = BigInt(fresh.otherAmountThreshold);
      if (minAmountOut < quote.minAmountOut)
        throw new Error("price moved below the recorded minimum");
      const swap = await jupiter<{
        swapTransaction: string;
        lastValidBlockHeight: number;
      }>("swap", {
        method: "POST",
        body: JSON.stringify({
          quoteResponse: fresh,
          userPublicKey: wallet,
          wrapAndUnwrapSol: false,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: 200_000,
              priorityLevel: "high",
            },
          },
        }),
      });
      const raw = fromBase64(swap.swapTransaction);
      const parsed = parseTransaction(raw);
      if (
        parsed.signatureCount !== 1 ||
        parsed.requiredSignatures !== 1 ||
        parsed.staticKeys[0] !== wallet
      )
        throw new Error(
          "Jupiter transaction must have the fee wallet as its only signer",
        );
      if (!parsed.programs.includes(JUPITER_PROGRAM))
        throw new Error(
          "Jupiter transaction does not call the Jupiter program",
        );
      const unexpected = parsed.programs.find((p) => !ALLOWED_PROGRAMS.has(p));
      if (unexpected)
        throw new Error(`Jupiter transaction calls ${unexpected}`);

      let lastValidBlockHeight = swap.lastValidBlockHeight;
      if (options.localBlockhash) {
        const latest = await rpc<{
          value: { blockhash: string; lastValidBlockHeight: number };
        }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
        raw.set(
          decodeBase58Bytes(latest.value.blockhash),
          parsed.blockhashOffset,
        );
        lastValidBlockHeight = latest.value.lastValidBlockHeight;
      }
      if (
        !Number.isSafeInteger(lastValidBlockHeight) ||
        lastValidBlockHeight <= 0
      )
        throw new Error("Jupiter returned an invalid block height");

      const usdcAccount = associatedTokenAccount(wallet, stablecoin);
      const before = await usdcBalance(usdcAccount);
      const simulation = await rpc<{
        value: {
          err: unknown;
          accounts: ({ data: [string, string] } | null)[] | null;
        };
      }>("simulateTransaction", [
        toBase64(raw),
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
          accounts: { encoding: "base64", addresses: [usdcAccount] },
        },
      ]);
      if (simulation.value.err !== null)
        throw new Error(
          `swap simulation failed: ${JSON.stringify(simulation.value.err).slice(0, 200)}`,
        );
      const account = simulation.value.accounts?.[0];
      if (!account)
        throw new Error("swap simulation did not credit the USDC account");
      const data = fromBase64(account.data[0]);
      const after = new DataView(data.buffer, data.byteOffset).getBigUint64(
        64,
        true,
      );
      if (after - before < minAmountOut)
        throw new Error(
          "swap simulation returned less than the signed minimum",
        );

      const message = raw.slice(parsed.messageOffset);
      const signature = ed25519.sign(message, seed);
      raw.set(signature, parsed.messageOffset - 64);
      return {
        txId: solanaBase58(signature),
        rawTx: toBase64(raw),
        evmNonce: null,
        expiresAt: lastValidBlockHeight,
        approvalTxId: null,
        minAmountOut,
      };
    },

    async broadcast(rawTx) {
      const raw = fromBase64(rawTx);
      const parsed = parseTransaction(raw);
      const expected = solanaBase58(
        raw.slice(parsed.messageOffset - 64, parsed.messageOffset),
      );
      const result = await rpc<string>("sendTransaction", [
        rawTx,
        { encoding: "base64", skipPreflight: true, maxRetries: 5 },
      ]);
      if (result !== expected) throw new Error("Broadcast signature mismatch");
    },

    async status(row: ConversionRow): Promise<SendStatus> {
      const statuses = await rpc<{
        value: ({ err: unknown; confirmationStatus: string | null } | null)[];
      }>("getSignatureStatuses", [
        [row.txId],
        { searchTransactionHistory: true },
      ]);
      const status = statuses.value[0];
      if (status) {
        if (status.confirmationStatus !== "finalized")
          return { kind: "pending" };
        if (status.err !== null)
          return { kind: "failed", reason: "swap transaction failed on chain" };
        const transaction = await rpc<{
          meta: {
            preTokenBalances: TokenBalance[];
            postTokenBalances: TokenBalance[];
          };
        } | null>("getTransaction", [
          row.txId,
          {
            commitment: "finalized",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          },
        ]);
        if (!transaction) return { kind: "pending" };
        const total = (balances: TokenBalance[]) =>
          balances
            .filter((b) => b.owner === wallet && b.mint === stablecoin)
            .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
        const delta =
          total(transaction.meta.postTokenBalances) -
          total(transaction.meta.preTokenBalances);
        return { kind: "finalized", amountOut: delta > 0n ? delta : 0n };
      }
      const height = await rpc<number>("getBlockHeight", [
        { commitment: "finalized" },
      ]);
      // A finalized height past the blockhash window proves the bytes can
      // never land, so a new attempt cannot double-spend this one.
      if (row.expiresAt !== null && height > row.expiresAt)
        return { kind: "failed", reason: "blockhash expired before inclusion" };
      return { kind: "rebroadcast" };
    },
  };
}

interface TokenBalance {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}
