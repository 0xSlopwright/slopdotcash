const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index]),
);

/** Decodes base58 of any length, such as Solana instruction data. */
export function decodeBase58Bytes(value: string): Uint8Array {
  const bytes: number[] = [0];
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw new TypeError("invalid base58 value");
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const leadingZeroes = value.match(/^1*/u)?.[0].length ?? 0;
  const significant = bytes.length === 1 && bytes[0] === 0 ? [] : bytes;
  const decoded = new Uint8Array(leadingZeroes + significant.length);
  for (let index = 0; index < significant.length; index += 1)
    decoded[decoded.length - 1 - index] = significant[index];
  return decoded;
}
