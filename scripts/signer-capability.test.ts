/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { assertPublicSignerReport } from "../src/lib/signer-capability";

const SOLANA_MEMBER = "9EyxVhhnCJH4QL5bDsRyukrkHFyitFMuf45UDdLxm4BY";
const BASE_MEMBER = "0x8f77c37d8650776bfe73c9b12b15209ee15d9b86";
const UINT256_MAX = (1n << 256n) - 1n;

function report(instrumentId: string, role: string, member: string) {
  return {
    projectId: "slopdotcash",
    cycleId: "2026-10",
    instrumentId,
    role,
    member,
    capability: "can-sign",
    reportedAt: "2026-10-14T00:00:00.000Z",
    expiresAt: "2026-10-14T12:00:00.000Z",
    reason: "Signer capability test report",
    sourceRepository: "SlopDotCash/slopdotcash",
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

describe("assertPublicSignerReport instrument identity bounds", () => {
  it("accepts a Squads vault index at the unsigned-byte maximum", () => {
    for (const kind of ["squads-v4-vault", "squads-project-vault"] as const) {
      const role = kind === "squads-v4-vault" ? "funder" : "creator";
      expect(
        assertPublicSignerReport(
          report(
            `${kind}:solana:${SOLANA_MEMBER}:255:${SOLANA_MEMBER}`,
            role,
            SOLANA_MEMBER,
          ),
        ).instrumentId,
      ).toBe(`${kind}:solana:${SOLANA_MEMBER}:255:${SOLANA_MEMBER}`);
    }
  });

  it("rejects a Squads vault index above the unsigned-byte maximum", () => {
    for (const index of ["256", "999", "999999"]) {
      expect(() =>
        assertPublicSignerReport(
          report(
            `squads-v4-vault:solana:${SOLANA_MEMBER}:${index}:${SOLANA_MEMBER}`,
            "funder",
            SOLANA_MEMBER,
          ),
        ),
      ).toThrow("Invalid public signer report");
      expect(() =>
        assertPublicSignerReport(
          report(
            `squads-project-vault:solana:${SOLANA_MEMBER}:${index}:${SOLANA_MEMBER}`,
            "creator",
            SOLANA_MEMBER,
          ),
        ),
      ).toThrow("Invalid public signer report");
    }
  });

  it("accepts a Sablier stream id at the uint256 maximum", () => {
    const instrumentId = `sablier-lockup-v4:base:${BASE_MEMBER}:${UINT256_MAX.toString()}`;
    expect(
      assertPublicSignerReport(report(instrumentId, "recipient", BASE_MEMBER))
        .instrumentId,
    ).toBe(instrumentId);
  });

  it("rejects a Sablier stream id above the uint256 maximum", () => {
    expect(() =>
      assertPublicSignerReport(
        report(
          `sablier-lockup-v4:base:${BASE_MEMBER}:${(UINT256_MAX + 1n).toString()}`,
          "recipient",
          BASE_MEMBER,
        ),
      ),
    ).toThrow("Invalid public signer report");
  });
});
