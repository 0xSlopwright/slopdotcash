import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  type BindingInput,
  evmBindingDigest,
} from "../../contracts/evm/adapter";
import { solanaAddressBytes } from "../../src/lib/wallets";

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function personalMessageHash(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${bytes.length}`,
  );
  const data = new Uint8Array(prefix.length + bytes.length);
  data.set(prefix);
  data.set(bytes, prefix.length);
  return keccak_256(data);
}
/** Recovers the externally owned account that produced a 65-byte secp256k1 signature over a digest. */
function recoverEvmSigner(digest: Uint8Array, signature: string): string {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new Error("Invalid signature");
  const bytes = Uint8Array.from(signature.slice(2).match(/../g) ?? [], (b) =>
    Number.parseInt(b, 16),
  );
  const recovery = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
  if (recovery !== 0 && recovery !== 1) throw new Error("Invalid recovery id");
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(bytes.slice(0, 64), 1);
  const publicKey = secp256k1.Point.fromBytes(
    secp256k1.recoverPublicKey(recovered, digest, { prehash: false }),
  ).toBytes(false);
  return `0x${hex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}
/** The destination wallet's EIP-712 acceptance of one exact EVM binding (ProjectEscrow.bindingDigest). EOA only. */
export function verifyEvmBindingSignature(
  chainId: bigint,
  vault: string,
  input: BindingInput,
  signature: string,
): boolean {
  try {
    const digest = Uint8Array.from(
      evmBindingDigest(chainId, vault, input).slice(2).match(/../g) ?? [],
      (b) => Number.parseInt(b, 16),
    );
    return (
      recoverEvmSigner(digest, signature) === input.destination.toLowerCase()
    );
  } catch {
    return false;
  }
}
/** Only EOA personal_sign and Solana Ed25519 wallets. Contract wallets need reviewed recovery. */
export function verifyPaymentWalletSignature(
  chain: string,
  address: string,
  message: string,
  signature: string,
): boolean {
  try {
    if (chain === "solana") {
      if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
      const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
      return ed25519.verify(
        bytes,
        new TextEncoder().encode(message),
        solanaAddressBytes(address),
        { zip215: false },
      );
    }
    if (chain !== "base") return false;
    return (
      recoverEvmSigner(personalMessageHash(message), signature) ===
      address.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function buildPaymentWalletMessage(input: {
  actorId: string;
  chain: string;
  address: string;
  claimId: string;
  claimDigest: string;
  nonce: string;
  expiresAt: string;
}): string {
  return `Authorize Slop automatic contributor payouts\nAudience: slop.cash\nGitHub actor: ${input.actorId}\nChain: ${input.chain}\nWallet: ${input.address}\nClaim: ${input.claimId}\nDigest: ${input.claimDigest}\nNonce: ${input.nonce}\nExpires: ${input.expiresAt}`;
}
