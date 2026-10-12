export type PaymentChain = "base" | "solana";
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
  balances: { chain: PaymentChain; netMicro: string }[];
  /** Imported from reviewed disclosures; never an escrow `paid` state. */
  directTransfers: DirectTransfer[];
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
  return null;
}
