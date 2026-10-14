/// <reference types="bun-types" />
/**
 * Tests for the canonical funding receiving-address boundary in
 * src/lib/funding-address.mjs: SegWit witness program lengths per
 * BIP173/BIP341/BIP350. A version 1 (Taproot) program is exactly 32 bytes;
 * any other version 1 length is not a Taproot output and is
 * anyone-can-spend, so it must never validate as a funding address.
 */
import { describe, expect, it } from "bun:test";
import { isFundingAddress } from "../src/lib/funding-address.mjs";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < GENERATORS.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= GENERATORS[index] as number;
    }
  }
  return checksum >>> 0;
}

function convertBits(data: number[], from: number, to: number): number[] {
  let accumulator = 0;
  let bits = 0;
  const out: number[] = [];
  for (const value of data) {
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >> bits) & ((1 << to) - 1));
    }
  }
  if (bits > 0) out.push((accumulator << (to - bits)) & ((1 << to) - 1));
  return out;
}

function encodeSegwit(version: number, program: number[]): string {
  const data = [version, ...convertBits(program, 8, 5)];
  const constant = version === 0 ? 1 : 0x2bc830a3;
  const mod = polymod([3, 3, 0, 2, 3, ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = [0, 1, 2, 3, 4, 5].map(
    (index) => (mod >>> (5 * (5 - index))) & 31,
  );
  return `bc1${[...data, ...checksum].map((digit) => CHARSET[digit]).join("")}`;
}

const program = (length: number): number[] =>
  Array.from({ length }, (_, index) => index + 1);

describe("isFundingAddress bitcoin", () => {
  it("accepts the BIP173 version 0 20-byte example", () => {
    expect(
      isFundingAddress("bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),
    ).toBe(true);
  });

  it("accepts a version 0 32-byte program (P2WSH)", () => {
    expect(isFundingAddress("bitcoin", encodeSegwit(0, program(32)))).toBe(
      true,
    );
  });

  it("rejects a version 0 program of any other length", () => {
    expect(isFundingAddress("bitcoin", encodeSegwit(0, program(21)))).toBe(
      false,
    );
  });

  it("accepts the BIP341 version 1 32-byte example (P2TR)", () => {
    expect(
      isFundingAddress(
        "bitcoin",
        "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
      ),
    ).toBe(true);
  });

  it("rejects a version 1 program that is not 32 bytes", () => {
    expect(isFundingAddress("bitcoin", encodeSegwit(1, program(20)))).toBe(
      false,
    );
    expect(isFundingAddress("bitcoin", encodeSegwit(1, program(40)))).toBe(
      false,
    );
  });

  it("keeps future witness versions forward-compatible (BIP350)", () => {
    expect(isFundingAddress("bitcoin", encodeSegwit(2, program(20)))).toBe(
      true,
    );
  });
});
