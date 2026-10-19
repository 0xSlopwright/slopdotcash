import type { D1Database } from "../../backend/trace/cloudflare-persistence";
import {
  assertEscrowPolicy,
  ESCROW_NETWORKS,
  type EscrowDeployment,
  paymentDeploymentRecord,
} from "../../src/lib/escrow-policy.mjs";
import type { PaymentDeployment } from "./index";

export type PaymentNetwork = EscrowDeployment["network"];

/**
 * `PAYMENT_NETWORKS` selects the registry networks one payments Worker
 * serves: a JSON array of unique registry network names. A missing, empty,
 * unknown or repeated name stops the Worker; nothing defaults to a network.
 */
export function parsePaymentNetworks(value: unknown): PaymentNetwork[] {
  let names: unknown;
  try {
    names = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    names = undefined;
  }
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    new Set(names).size !== names.length ||
    !names.every(
      (name) =>
        typeof name === "string" && Object.hasOwn(ESCROW_NETWORKS, name),
    )
  )
    throw new Error(
      "PAYMENT_NETWORKS must be a JSON array of unique registry networks",
    );
  return names as PaymentNetwork[];
}

export interface RegistryDeployments {
  deployments: PaymentDeployment[];
  /** One entry per project whose current manifest has an invalid escrow policy. */
  failures: Error[];
}

/**
 * Reads the escrow deployments of the selected networks from the current
 * revision of every project in the D1 registry. The registry is the only
 * project inventory, so a vault recorded by an admin revision is found on the
 * next run without a Worker change. A paused project keeps its vault and its
 * funded obligations, so its deployments stay in scope. One invalid manifest
 * is reported and skipped; it never removes the other projects' vaults.
 */
export async function loadRegistryPaymentDeployments(
  db: D1Database,
  networks: readonly PaymentNetwork[],
): Promise<RegistryDeployments> {
  const row = await db
    .prepare(
      "SELECT json_group_array(json_object('id',id,'manifest',manifest)) items FROM (SELECT id,manifest FROM projects ORDER BY id)",
    )
    .first<{ items: string }>();
  if (!row) throw new Error("Project registry unavailable");
  const selected = new Set<string>(networks);
  const deployments: PaymentDeployment[] = [];
  const failures: Error[] = [];
  for (const project of JSON.parse(row.items) as {
    id: string;
    manifest: string;
  }[]) {
    try {
      const manifest = JSON.parse(project.manifest) as {
        id?: unknown;
        escrow?: unknown;
      };
      if (manifest.id !== project.id)
        throw new Error("Project manifest identity mismatch");
      if (manifest.escrow === undefined) continue;
      for (const deployment of assertEscrowPolicy(manifest.escrow).deployments)
        if (selected.has(deployment.network))
          deployments.push(
            // The record keeps the manifest's null fields; the adapters treat
            // a null field as absent, as they did for the generated variable.
            paymentDeploymentRecord(
              project.id,
              deployment,
            ) as unknown as PaymentDeployment,
          );
    } catch (error) {
      failures.push(
        new Error(`Project ${project.id} escrow deployments unavailable`, {
          cause: error,
        }),
      );
    }
  }
  return { deployments, failures };
}
