/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { assertEvaluatorAwardManifest } from "../src/lib/evaluator-awards";

const baseline = JSON.parse(
  readFileSync(
    new URL(
      "../tests/fixtures/history/evaluations/delta-star/award-region-middle-counterexample-23.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function manifestWithDecisionUrl(decisionUrl: string) {
  const manifest = structuredClone(baseline);
  manifest.review.decisionUrl = decisionUrl;
  return manifest;
}

describe("assertEvaluatorAwardManifest review decision URL", () => {
  it("accepts the checked-in canonical decision URL", () => {
    expect(() =>
      assertEvaluatorAwardManifest(structuredClone(baseline)),
    ).not.toThrow();
  });

  it("rejects a decision URL with embedded credentials", () => {
    expect(() =>
      assertEvaluatorAwardManifest(
        manifestWithDecisionUrl(
          "https://user:secret@github.com/SlopDotCash/slopdotcash/pull/129",
        ),
      ),
    ).toThrow("must be a Slop review pull request");
    expect(() =>
      assertEvaluatorAwardManifest(
        manifestWithDecisionUrl(
          "https://:secret@github.com/SlopDotCash/slopdotcash/pull/129",
        ),
      ),
    ).toThrow("must be a Slop review pull request");
  });

  it("rejects a decision URL with a non-default port", () => {
    expect(() =>
      assertEvaluatorAwardManifest(
        manifestWithDecisionUrl(
          "https://github.com:8443/SlopDotCash/slopdotcash/pull/129",
        ),
      ),
    ).toThrow("must be a Slop review pull request");
  });
});
