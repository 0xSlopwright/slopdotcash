import { useCallback } from "react";
import { browserDeployment } from "./browser-deployment";
import { fetchWithDeadline, readBoundedJson } from "./browser-json";
import type { DirectTransfer } from "./payments/contracts";
import { usePublicResource } from "./use-public-resource";

const money = (v: unknown) =>
  typeof v === "string" && /^(0|[1-9]\d*)$/u.test(v);

/** Validates one direct transfer from the payments API. */
export function isDirectTransfer(t: unknown): t is DirectTransfer {
  const v = t as DirectTransfer;
  return (
    !!v &&
    typeof v.projectId === "string" &&
    /^\d{4}-(0[1-9]|1[0-2])$/u.test(v.contributionMonth) &&
    /^[1-9]\d*$/u.test(v.githubUserId) &&
    typeof v.login === "string" &&
    typeof v.network === "string" &&
    (v.chain === "solana" || v.chain === "base") &&
    typeof v.recipient === "string" &&
    money(v.amountMicro) &&
    typeof v.transactionId === "string" &&
    !Number.isNaN(Date.parse(v.blockTime))
  );
}

/**
 * Loads transfers sent outside escrow from the payments database, for one
 * project or one numeric GitHub actor. A failed read stays an error; it never
 * becomes an empty list.
 */
export function useDirectTransfers(
  scope: { projectId: string } | { githubUserId: string } | null,
) {
  const path = !scope
    ? ""
    : "projectId" in scope
      ? `projects/${encodeURIComponent(scope.projectId)}`
      : `actors/${encodeURIComponent(scope.githubUserId)}`;
  const load = useCallback(
    async (signal: AbortSignal) => {
      // The payments API answers only the deployed product origins.
      if (!browserDeployment.browserOrigins.has(window.location.origin))
        throw new Error("Direct payment records unavailable");
      const response = await fetchWithDeadline(
        `/api/v1/payments/${path}/direct-transfers`,
        { signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error("Direct payment records unavailable");
      const value = (await readBoundedJson(
        response,
        1_048_576,
        "direct payments",
      )) as { transfers?: unknown; totalMicro?: unknown };
      if (
        !Array.isArray(value.transfers) ||
        !value.transfers.every(isDirectTransfer) ||
        !money(value.totalMicro)
      )
        throw new Error("Direct payment records could not be verified");
      return { transfers: value.transfers as DirectTransfer[] };
    },
    [path],
  );
  return usePublicResource(
    Boolean(path),
    load,
    "Direct payment records unavailable",
  );
}
