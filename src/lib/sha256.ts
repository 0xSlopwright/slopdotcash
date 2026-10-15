import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** Browser-safe synchronous SHA-256 shared by public-data validation and generators. */
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(
    sha256(typeof input === "string" ? utf8ToBytes(input) : input),
  );
}
