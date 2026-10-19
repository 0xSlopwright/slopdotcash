import { useEffect, useState } from "react";
import { readBoundedJson } from "./lib/browser-json";
import { ESCROW_NETWORKS } from "./lib/escrow-policy.mjs";
import type { ProjectDefinition } from "./lib/projects.mjs";

interface Totals {
  network: string;
  totalNetPaidMicro: string;
  payoutFeesPaidMicro: string;
  reservedNetMicro: string;
  reservedFeeMicro: string;
  syncedAt: string | null;
  coverage: { kind: string; completeThrough: string | null };
}
const chainNames = {
  base: "Base",
  solana: "Solana",
  robinhood: "Robinhood Chain",
  ethereum: "Ethereum",
} as const;

function amount(value: string, network: string) {
  const n = BigInt(value);
  const symbol = Object.hasOwn(ESCROW_NETWORKS, network)
    ? ESCROW_NETWORKS[network as keyof typeof ESCROW_NETWORKS].assetSymbol
    : "USDC";
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")} ${symbol}`;
}

export function EscrowFunding({ project }: { project: ProjectDefinition }) {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const deployed = Boolean(project.escrow?.deployments.length);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh reloads the verified projection.
  useEffect(() => {
    setTotals(null);
    setError("");
    if (!deployed) return;
    const controller = new AbortController();
    fetch(
      `/api/v1/payments/projects/${encodeURIComponent(project.id)}/totals`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Verified payout totals are not available yet.");
        const value = (await readBoundedJson(
          response,
          65536,
          "project payout totals",
        )) as Totals;
        if (
          ![
            value.totalNetPaidMicro,
            value.payoutFeesPaidMicro,
            value.reservedNetMicro,
            value.reservedFeeMicro,
          ].every((n) => typeof n === "string" && /^(0|[1-9]\d*)$/.test(n)) ||
          value.coverage?.kind !== "finalized-payment-events"
        )
          throw new Error("Invalid payout totals.");
        if (!controller.signal.aborted) setTotals(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not verify payouts.",
          );
      });
    return () => controller.abort();
  }, [project.id, deployed, revision]);
  return (
    <section className="section project-funding" aria-label="Project escrow">
      <h2>{chainNames[project.escrow?.chain ?? "solana"]} escrow</h2>
      <p>
        Contributor amounts deduct a 2% fee. Funded awards remain reserved until
        paid. Returning unused sponsor funds costs 10%.
      </p>
      {!deployed ? (
        <p>
          Escrow deployment is pending review. This project is not accepting
          escrow funding yet.
        </p>
      ) : (
        <>
          <p>
            Only the project owner can fund this version through its deposit
            transaction. Direct token transfers do not create reward or refund
            credit. Public donations are not enabled.
          </p>
          {error ? (
            <p role="alert">{error}</p>
          ) : !totals ? (
            <p role="status">Checking finalized payout records…</p>
          ) : (
            <>
              <dl>
                <dt>Indexed contributor payouts</dt>
                <dd>{amount(totals.totalNetPaidMicro, totals.network)}</dd>
                <dt>Indexed payout fees</dt>
                <dd>{amount(totals.payoutFeesPaidMicro, totals.network)}</dd>
                <dt>Reserved contributor awards</dt>
                <dd>{amount(totals.reservedNetMicro, totals.network)}</dd>
                <dt>Reserved payout fees</dt>
                <dd>{amount(totals.reservedFeeMicro, totals.network)}</dd>
              </dl>
              <p>
                Network: {totals.network}.{" "}
                {totals.coverage.completeThrough
                  ? "Finalized event scan recorded."
                  : "Initial event scan is incomplete."}{" "}
                These figures describe indexed awards and payments; they are not
                the vault balance.
              </p>
            </>
          )}
          <button
            className="button secondary-button"
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh verified totals
          </button>
        </>
      )}
      <p>
        <a href="/earnings">View your payouts and wallets</a>
      </p>
    </section>
  );
}
