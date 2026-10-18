/**
 * Runs the complete browser matrix against the stable built-site preview and,
 * at the same time, checks redirects, artifacts, and contributor API access
 * with Pages headers. Wrangler can terminate during long browser sessions on
 * constrained hosted runners, while that focused check still exercises the
 * behavior only Pages supplies instead of replacing it with a generic
 * static-server assertion. Each phase owns its own port and output folder, so
 * the two phases run concurrently and neither can serve the other's bytes.
 * SLOP_E2E_LANE=preview|pages runs one phase only, so CI can split the phases
 * (and preview shards passed as --shard=N/M) across separate runners.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnvironment } from "./child-environment.mjs";
import { runE2ePhase } from "./run-e2e-phase.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwright = join(packageRoot, "node_modules", ".bin", "playwright");
function runSync(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: childEnvironment(),
    stdio: "inherit",
    timeout: 40 * 60_000,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runPhase(label, server, port, args) {
  return runE2ePhase({
    label,
    command: playwright,
    args: ["test", ...args],
    cwd: packageRoot,
    env: {
      ...childEnvironment(),
      SLOP_E2E_PREBUILT: "1",
      SLOP_E2E_FORCE_FRESH_SERVER: "1",
      SLOP_E2E_SERVER: server,
      SLOP_E2E_PORT: port,
      ...(process.env.SLOP_E2E_WORKERS
        ? { SLOP_E2E_WORKERS: process.env.SLOP_E2E_WORKERS }
        : {}),
    },
  });
}

const lane = process.env.SLOP_E2E_LANE;
if (lane !== undefined && lane !== "preview" && lane !== "pages") {
  throw new TypeError(`Unsupported SLOP_E2E_LANE: ${lane}`);
}

// Releases must exercise the online build without regenerating its journal.
if (process.env.SLOP_E2E_PREBUILT !== "1") runSync("bun", ["run", "build"]);
runSync("node", ["scripts/dist-manifest.mjs", "verify-local", "dist"]);

// The preview phase binds the base port and Pages binds the next one.
const basePort = Number(process.env.SLOP_E2E_PORT ?? "4466");
if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65534) {
  throw new TypeError(`Invalid SLOP_E2E_PORT: ${process.env.SLOP_E2E_PORT}`);
}
const extraArgs = process.argv.slice(2);
const phases = [
  {
    server: "preview",
    port: String(basePort),
    args: ["--grep-invert", "@pages-only", ...extraArgs],
  },
  {
    server: "pages",
    port: String(basePort + 1),
    args: ["--project=wide-desktop-chromium", "--grep", "@pages", ...extraArgs],
  },
];
const statuses = await Promise.all(
  phases
    .filter((phase) => lane === undefined || phase.server === lane)
    .map(({ server, port, args }) => runPhase(server, server, port, args)),
);
const failed = statuses.find((status) => status !== 0);
if (failed !== undefined) process.exit(failed);
