import type { EscrowChain } from "../escrow-policy.mjs";

export type PaymentChain = EscrowChain;
export interface AccountPayment {
  id: string;
  projectId: string;
  network: string;
  chain: PaymentChain;
  grossMicro: string;
  netMicro: string;
  feeMicro: string;
  state: "reserved" | "paid";
  deliveryState:
    | "needs_wallet"
    | "awaiting_binding"
    | "submitted"
    | "held"
    | "paid";
  submittedTransactionId: string | null;
  transactionId: string | null;
}
export interface PaymentsAccount {
  githubUserId: string;
  wallets: {
    chain: PaymentChain;
    claimId: string;
    address: string;
    authorized: boolean;
    activationEligibleAt: string | null;
  }[];
  payments: AccountPayment[];
  /** Unpaid net per settlement network; never summed across networks or assets. */
  balances: { chain: PaymentChain; network: string; netMicro: string }[];
  /** Imported from reviewed disclosures; never an escrow `paid` state. */
  directTransfers: DirectTransfer[];
  /** Legacy README observations; history only, never a payout destination. */
  walletObservations: WalletObservation[];
}
export interface WalletObservation {
  chain: PaymentChain;
  address: string;
  proofLevel: "profile_readme";
  sourceUrl: string;
  observedAt: string;
}
/** A transfer a project creator sent outside escrow and Slop settlement. */
export interface DirectTransfer {
  projectId: string;
  contributionMonth: string;
  githubUserId: string;
  login: string;
  network: string;
  chain: PaymentChain;
  recipient: string;
  amountMicro: string;
  transactionId: string;
  blockTime: string;
}
/** Fees are deducted from the gross award; integer micro-USDC only. */
export function payoutFee(gross: bigint): bigint {
  if (gross <= 0n || gross > 18446744073709551615n)
    throw new Error("Invalid gross award");
  return gross / 50n;
}

/** Public explorer link for a payment transaction, or null when none exists. */
export function transactionUrl(
  network: string,
  id: string | null,
): string | null {
  if (!id) return null;
  if (network === "base-sepolia")
    return `https://sepolia.basescan.org/tx/${encodeURIComponent(id)}`;
  if (network === "base-mainnet")
    return `https://basescan.org/tx/${encodeURIComponent(id)}`;
  if (network === "solana-mainnet")
    return `https://explorer.solana.com/tx/${encodeURIComponent(id)}`;
  if (network === "solana-devnet" || network === "solana-testnet")
    return `https://explorer.solana.com/tx/${encodeURIComponent(id)}?cluster=${network.slice(7)}`;
  if (network === "robinhood-mainnet")
    return `https://robinhoodchain.blockscout.com/tx/${encodeURIComponent(id)}`;
  if (network === "robinhood-testnet")
    return `https://explorer.testnet.chain.robinhood.com/tx/${encodeURIComponent(id)}`;
  return null;
}
