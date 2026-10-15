/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  assertProjectFundingRecord,
  type ProjectFundingAddress,
} from "../src/lib/funding";

// The donor login bound is the canonical GitHub login pattern used by every
// other identity validator in this repository (funding-instruments.mjs,
// rewards.ts, evaluator-awards.ts, cycle-index.ts, project-schema.mjs):
// at most 39 characters and no trailing hyphen.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

const txBytes = new Uint8Array(64);
for (let i = 0; i < 64; i++) txBytes[i] = (i * 7 + 3) % 256;
const recipient = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const addresses: readonly ProjectFundingAddress[] = [
  {
    network: "solana",
    asset: "USDC",
    address: recipient,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    replacedAt: null,
  },
];

function recordWithLogin(login: string) {
  return {
    schemaVersion: "1",
    kind: "project-funding",
    recordId: "fund_probe001",
    projectId: "testproj",
    manifestRevision: "a".repeat(40),
    network: "solana",
    asset: "USDC",
    transactionId: base58(txBytes),
    recipient,
    amountMinor: "1000000",
    observedAt: "2026-06-01T00:00:00.000Z",
    state: "self-reported",
    donor: {
      attribution: "github",
      actorId: "123456",
      actorNodeId: "U_probe123",
      login,
    },
    finality: { kind: "unverified" },
    verifier: null,
    supersedes: null,
  };
}

describe("assertProjectFundingRecord donor login", () => {
  it("accepts logins up to the 39-character GitHub maximum", () => {
    for (const login of [
      "a",
      "a".repeat(39),
      `${"a".repeat(19)}-${"b".repeat(19)}`,
    ]) {
      expect(() =>
        assertProjectFundingRecord(recordWithLogin(login), addresses),
      ).not.toThrow();
    }
  });

  it("rejects a 40-character login, which cannot exist on GitHub", () => {
    expect(() =>
      assertProjectFundingRecord(recordWithLogin("a".repeat(40)), addresses),
    ).toThrow("funding record donor identity is invalid");
  });

  it("rejects a trailing-hyphen login", () => {
    expect(() =>
      assertProjectFundingRecord(
        recordWithLogin(`${"a".repeat(38)}-`),
        addresses,
      ),
    ).toThrow("funding record donor identity is invalid");
  });
});
