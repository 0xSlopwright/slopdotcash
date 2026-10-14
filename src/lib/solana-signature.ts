/**
 * The one canonical decoding of a Solana Ed25519 signature, shared by the
 * wallet-possession validator and the payment wallet verifier. A signature
 * is exactly 64 bytes in padded base64, and the encoding itself is part of
 * the binding: `atob` discards the unused low bits of the final character,
 * so a changed encoding of the same bytes passes the pattern alone. The
 * decoded bytes are re-encoded and the exact string is required, so a
 * signature has exactly one accepted representation wherever it is stored
 * or reverified. This module is runtime-neutral: it uses only the global
 * `atob`/`btoa` available in browsers, Workers, Node, and Bun.
 */

/** Ed25519 detached signatures are exactly 64 bytes, padded base64. */
export const SOLANA_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u;

/**
 * Decodes a canonical Solana signature, or returns null when the value is
 * not a string in the one canonical form, does not decode to exactly
 * 64 bytes, or is a non-canonical encoding of its bytes. Callers keep
 * their own contract for the null case: throw, or return false.
 */
export function decodeSolanaSignature(signature: unknown): Uint8Array | null {
  if (
    typeof signature !== "string" ||
    !SOLANA_SIGNATURE_PATTERN.test(signature)
  ) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(signature);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.length !== 64) {
    return null;
  }
  let reencoded = "";
  for (let index = 0; index < bytes.length; index += 1) {
    reencoded += String.fromCharCode(bytes[index]);
  }
  if (btoa(reencoded) !== signature) {
    return null;
  }
  return bytes;
}
