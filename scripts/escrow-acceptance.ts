/**
 * PRD section 21 escrow acceptance runner (issue #902).
 *
 *   bun scripts/escrow-acceptance.ts <network> <evidence-directory>
 *
 * Networks: base-sepolia, ethereum-sepolia, robinhood-testnet, solana-devnet,
 * and solana-localnet (loopback validator only). Mainnet chain ids and the
 * Solana mainnet genesis are refused before any key signs. RPC URLs, contract
 * addresses and test keys come from environment variables; see
 * docs/escrow-acceptance-runbook.md. The run is resumable: it saves every
 * signed transaction before broadcast, and exits with code 75 while it waits
 * for a binding delay or finality. Rerun the same command to continue.
 */
import { resolve } from "node:path";
import { runEvm } from "./escrow-acceptance/evm";
import {
  type Evidence,
  evidencePath,
  isAcceptanceNetwork,
  WAITING_EXIT_CODE,
} from "./escrow-acceptance/shared";

const [network, directory] = process.argv.slice(2);
if (!network || !directory || !isAcceptanceNetwork(network)) {
  console.error(
    "Usage: bun scripts/escrow-acceptance.ts <base-sepolia|ethereum-sepolia|robinhood-testnet|solana-devnet|solana-localnet> <evidence-directory>",
  );
  process.exit(2);
}
const out = resolve(directory);
// The Solana leg needs the program's SPL dependencies from contracts/solana.
const solanaLeg = "../contracts/solana/scripts/acceptance.ts";
const evidence: Evidence = network.startsWith("solana-")
  ? await (
      (await import(solanaLeg)) as {
        runSolana(network: string, directory: string): Promise<Evidence>;
      }
    ).runSolana(network, out)
  : await runEvm(network, out);
console.log(
  JSON.stringify(
    {
      network: evidence.network,
      status: evidence.status,
      waiting: evidence.waiting,
      assets: evidence.assets.map((asset) => ({
        address: asset.address,
        decimals: asset.decimals,
        status: asset.status,
      })),
      deviations: evidence.deviations,
      errors: evidence.errors,
      evidence: evidencePath(out),
    },
    null,
    2,
  ),
);
process.exit(
  evidence.status === "passed"
    ? 0
    : evidence.status === "waiting"
      ? WAITING_EXIT_CODE
      : 1,
);
