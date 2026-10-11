/**
 * Finalized USDC transfers that published disclosures record as sent outside
 * Slop's verified cycle flow. They are reported, never lifecycle "paid".
 */
type Disclosure = {
  projectId: string;
  contributionMonth: string;
  observedAt: string;
  rows: {
    actorId: string;
    state: string;
    observed: null | { amountMinor: string; signature: string };
  }[];
};

export type DirectPayment = {
  projectId: string;
  contributionMonth: string;
  observedAt: string;
  actorId: string;
  amountMinor: bigint;
  signature: string;
};

const disclosures = import.meta.glob("../../disclosures/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Disclosure>;

const seen = new Set<string>();
export const directPayments: readonly DirectPayment[] = Object.values(
  disclosures,
).flatMap((d) =>
  d.rows.flatMap((r) => {
    const o = r.observed;
    if (
      r.state !== "paid-direct" ||
      !o ||
      !/^\d+$/.test(o.amountMinor) ||
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(o.signature) ||
      seen.has(o.signature)
    )
      return [];
    seen.add(o.signature);
    return [
      {
        projectId: d.projectId,
        contributionMonth: d.contributionMonth,
        observedAt: d.observedAt,
        actorId: r.actorId,
        amountMinor: BigInt(o.amountMinor),
        signature: o.signature,
      },
    ];
  }),
);
