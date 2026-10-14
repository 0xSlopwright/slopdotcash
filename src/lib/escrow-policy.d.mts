export interface EscrowDeployment {
  network:
    | "base-sepolia"
    | "base-mainnet"
    | "solana-devnet"
    | "solana-testnet"
    | "solana-mainnet";
  vault: string;
  programId: string | null;
  upgradeAuthority: string | null;
  projectPda: string | null;
  networkDomain: string | null;
  asset: string;
  owner: string;
  identityAuthority: string;
  feeRecipient: string;
  deploymentTransaction: string;
  sourceCommit: string;
  codeSha256: string;
  bindingDelaySeconds: string;
  /** Solana only; null on Base, where the factory fixes 7 days. */
  rotationDelaySeconds: string | null;
  /** Base only; null on Solana. The EscrowFactory that created the vault and rotates its identity authority. */
  factory: string | null;
  /** Base only; null on Solana. sha256 of the factory runtime code. */
  factoryCodeSha256: string | null;
  /** Base only; null on Solana. The factory registrar, which alone proposes an authority rotation. */
  registrar: string | null;
}
export interface EscrowPolicy {
  schemaVersion: "1";
  effectiveCycle: string;
  chain: "base" | "solana";
  feeBasisPoints: 200;
  withdrawalFeeBasisPoints: 1000;
  feeMode: "deduct-from-gross";
  deployments: EscrowDeployment[];
}
export declare const MIN_PRODUCTION_BINDING_DELAY: number;
export declare const MIN_PRODUCTION_ROTATION_DELAY: number;
export declare const ESCROW_NETWORKS: Readonly<
  Record<
    EscrowDeployment["network"],
    {
      chain: "base" | "solana";
      testnet: boolean;
      chainId?: string;
      asset: string | null;
    }
  >
>;
export declare function assertEscrowPolicy(value: unknown): EscrowPolicy;
export declare function assertEscrowTransition(
  previous: EscrowPolicy | undefined,
  next: EscrowPolicy | undefined,
): void;
