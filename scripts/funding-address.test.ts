/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isFundingAddress } from "../src/lib/funding-address.mjs";

// Published BIP173, BIP341, and BIP350 address vectors.
describe("isFundingAddress bitcoin witness program lengths", () => {
  it("accepts version 0 and 32-byte version 1 programs", () => {
    for (const address of [
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    ]) {
      expect(isFundingAddress("bitcoin", address)).toBe(true);
    }
  });

  it("rejects an anyone-can-spend version 1 program that is not 32 bytes", () => {
    expect(
      isFundingAddress(
        "bitcoin",
        "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
      ),
    ).toBe(false);
  });

  it("keeps future witness versions forward-compatible", () => {
    expect(
      isFundingAddress("bitcoin", "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs"),
    ).toBe(true);
  });
});
