/** Preservation checks for strict funding records, not on-chain verification. */
import { expect, test } from "bun:test";
import { assertProjectFundingRecord } from "../src/lib/funding";
import { assertProjectCommitmentRecord } from "../src/lib/funding-commitment";

const recipient = "0x1111111111111111111111111111111111111111";
const common = {
  schemaVersion: "1",
  projectId: "eliza",
  manifestRevision: "a".repeat(40),
  network: "base",
  asset: "USDC",
  transactionId: `0x${"b".repeat(64)}`,
  observedAt: "2026-08-10T00:00:00.000Z",
  amountMinor: "123000000",
  state: "self-reported",
  finality: { kind: "unverified" },
  verifier: null,
  supersedes: null,
} as const;

for (const { name, record, validate } of [
  {
    name: "direct funding",
    record: {
      ...common,
      kind: "project-funding",
      recordId: "fund_validation",
      recipient,
      donor: { attribution: "anonymous" },
    },
    validate: (value: unknown) =>
      assertProjectFundingRecord(value, [
        {
          network: "base",
          asset: "USDC",
          address: recipient,
          effectiveAt: "2026-08-01T00:00:00.000Z",
          replacedAt: null,
        },
      ]),
  },
  {
    name: "committed funding",
    record: {
      ...common,
      kind: "project-commitment",
      recordId: "cmt_validation",
      event: "deposit",
      instrument: { contract: recipient, recipient, streamId: "1" },
    },
    validate: (value: unknown) =>
      assertProjectCommitmentRecord(value, [
        {
          kind: "sablier-lockup-v4",
          network: "base",
          asset: "USDC",
          contract: recipient,
          recipient,
          streamId: "1",
          deadline: "2026-09-01T00:00:00.000Z",
          effectiveAt: "2026-08-01T00:00:00.000Z",
          replacedAt: null,
        },
      ]),
  },
] as const) {
  test(`${name} keeps exact positive minor units and canonical UTC`, () => {
    expect(validate(record)).toEqual(record);
    const maximum = { ...record, amountMinor: "9".repeat(40) };
    expect(validate(maximum)).toEqual(maximum);
    for (const amountMinor of ["0", "01", "-1", "1.5", "1e6", "9".repeat(41)])
      expect(() => validate({ ...record, amountMinor })).toThrow(TypeError);
    for (const observedAt of [
      "2026-08-10T00:00:00Z",
      "2026-08-10T00:00:00.000+00:00",
      "2026-02-30T00:00:00.000Z",
    ])
      expect(() => validate({ ...record, observedAt })).toThrow(TypeError);
  });

  test(`${name} rejects absent, array, missing-field and extra-field records`, () => {
    for (const value of [null, [], { ...record, unexpected: true }])
      expect(() => validate(value)).toThrow(TypeError);
    const { amountMinor: _amount, ...incomplete } = record;
    expect(() => validate(incomplete)).toThrow(TypeError);
    expect(() =>
      validate({
        ...record,
        finality: { kind: "unverified", confirmations: 12 },
      }),
    ).toThrow(TypeError);
  });
}
