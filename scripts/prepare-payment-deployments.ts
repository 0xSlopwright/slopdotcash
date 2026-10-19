/**
 * Derive the signer roles' escrow deployment bindings from the D1 project
 * registry snapshot (`bun run projects:sync`). The snapshot is the reviewed
 * copy of the registry; this script keeps no second project inventory.
 */
import {
  ESCROW_NETWORKS,
  paymentDeploymentRecord,
} from "../src/lib/escrow-policy.mjs";
import { assertProjectRegistry } from "../src/lib/project-schema.mjs";
import { HISTORICAL_PROJECTS } from "../src/lib/projects.mjs";

export function paymentDeployments(
  definitions: unknown,
  environment: "testnet" | "mainnet",
  selectedNetwork?: string,
) {
  const result = [];
  for (const project of assertProjectRegistry(definitions)) {
    for (const deployment of project.escrow?.deployments ?? []) {
      if (selectedNetwork && deployment.network !== selectedNetwork) continue;
      if (
        ESCROW_NETWORKS[deployment.network].testnet !==
        (environment === "testnet")
      )
        continue;
      result.push(paymentDeploymentRecord(project.id, deployment));
    }
  }
  if (new Set(result.map((entry) => entry.projectId)).size !== result.length)
    throw new Error(
      "Select one explicit network per test database; do not combine project liabilities across test clusters",
    );
  return result;
}

if (import.meta.main) {
  const environment = process.argv[2];
  if (environment !== "testnet" && environment !== "mainnet")
    throw new Error("Select testnet or mainnet explicitly");
  const deployments = paymentDeployments(
    HISTORICAL_PROJECTS,
    environment,
    process.argv[3],
  );
  if (deployments.length === 0)
    throw new Error(
      "No reviewed escrow deployments exist for this environment",
    );
  process.stdout.write(`${JSON.stringify(deployments)}\n`);
}
