import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  ESCROW_NETWORKS,
  paymentDeploymentRecord,
} from "../../src/lib/escrow-policy.mjs";
import { assertProjectRegistry } from "../../src/lib/project-schema.mjs";
import { HISTORICAL_PROJECTS } from "../../src/lib/projects.mjs";
import { readRegistryDatabase } from "../payments/registry-database.mjs";
import { mainnetExecutionEnabled } from "./mainnet-execution.mjs";
import { SIGNER_STACKS } from "./signer-stacks.mjs";

// Local generation only: no resource creation, signing, secret reads, or deployment.
const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, "../..");
const ROLES = ["attester", "relayer", "dispatcher"];

/**
 * Builds the Wrangler configurations of one payment stack for one network.
 *
 * A `test` stack serves one registry test network with its own isolated
 * payment database. A `production` stack serves one registry mainnet. Its
 * payment database is the registry database (`SLOP_DB` in wrangler.toml),
 * because the account API writes wallet claims and binding authorizations
 * there; the Pages release applies its migrations, so no configuration here
 * migrates it. The production signers read only the production secrets and
 * journal of `signer-stacks.mjs`. The production dispatcher has no cron until
 * the network's reviewed `MAINNET_EXECUTION` value is `true`, so a generated
 * production stack is disabled by default. Every deployment must equal its
 * canonical project manifest in `registry`.
 */
export function paymentStack({
  stack = "test",
  network,
  databaseId,
  databaseName,
  deployments,
  registry,
  registryDatabase,
  executionEnabled = mainnetExecutionEnabled,
}) {
  const policy = Object.hasOwn(ESCROW_NETWORKS, network ?? "")
    ? ESCROW_NETWORKS[network]
    : undefined;
  if (stack === "test") {
    if (
      // Test stacks only: every registry test network, never a mainnet.
      policy?.testnet !== true ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        databaseId ?? "",
      ) ||
      !new RegExp(`^slop-payments-${network}(?:-[a-z0-9]+)*$`).test(
        databaseName ?? "",
      ) ||
      databaseName.length > 43
    )
      throw new Error(
        "Explicit test network and isolated slop-payments-NETWORK database identity required",
      );
    // The dispatcher finds vaults in the project registry, which is the Pages
    // SLOP_DB, not the isolated payment database (its projects table is empty).
    if (registryDatabase.database_id === databaseId)
      throw new Error(
        "The isolated payment database must not be the project registry database",
      );
  } else if (stack === "production") {
    if (policy?.testnet !== false)
      throw new Error("A production stack serves one registry mainnet");
    if (databaseId !== undefined || databaseName !== undefined)
      throw new Error(
        "A production stack uses the registry database; do not name another database",
      );
  } else throw new Error("Select --stack test or --stack production");
  if (!Array.isArray(deployments) || !deployments.length)
    throw new Error("Expected reviewed deployment array");
  const projects = assertProjectRegistry(registry);
  const seen = new Set();
  for (const deployment of deployments) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(deployment.projectId ?? "") ||
      deployment.network !== network ||
      seen.has(deployment.projectId)
    )
      throw new Error(
        "Exactly one network and one deployment per project required",
      );
    seen.add(deployment.projectId);
    const project = projects.find((item) => item.id === deployment.projectId);
    const reviewed = project?.escrow?.deployments.find(
      (item) => item.network === network,
    );
    const expected = reviewed && paymentDeploymentRecord(project.id, reviewed);
    if (!expected || !isDeepStrictEqual(expected, deployment))
      throw new Error(
        "Deployment differs from canonical project manifest; publish real chain evidence first",
      );
  }
  const production = stack === "production";
  const prefix = production ? `slop-payments-${network}` : databaseName;
  const names = Object.fromEntries(
    ROLES.map((role) => [role, `${prefix}-${role}`]),
  );
  const paymentsDatabase = production
    ? // No migrations_dir: the Pages release migrates the registry database.
      { binding: "PAYMENTS_DB", ...registryDatabase }
    : {
        binding: "PAYMENTS_DB",
        database_name: databaseName,
        database_id: databaseId,
        migrations_dir: resolve(repository, "migrations"),
      };
  const common = {
    compatibility_date: "2026-10-06",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [],
    d1_databases: [paymentsDatabase],
  };
  const family = policy.family;
  const crons = !production || executionEnabled(network) ? ["*/5 * * * *"] : [];
  const configs = {};
  for (const role of ROLES) {
    const signer = role !== "dispatcher";
    configs[role] = {
      ...common,
      name: names[role],
      main: resolve(root, signer ? "index.ts" : "../payments/index.ts"),
      // Signers sign only for the deployments pinned here at review time. The
      // dispatcher reads its vaults from the registry database (REGISTRY_DB).
      ...(signer
        ? {}
        : {
            d1_databases: [
              ...common.d1_databases,
              // No migrations_dir: this configuration never migrates the registry.
              { binding: "REGISTRY_DB", ...registryDatabase },
            ],
          }),
      vars: signer
        ? {
            PAYMENT_DEPLOYMENTS: JSON.stringify(deployments),
            SIGNER_ROLE: role,
            SIGNER_STACK: stack,
            CHAIN_FAMILY: family,
          }
        : { PAYMENT_NETWORKS: JSON.stringify([network]) },
      ...(signer
        ? {
            durable_objects: {
              bindings: [
                { name: "JOURNAL", class_name: "PaymentSignerJournal" },
              ],
            },
            migrations: [
              { tag: "v1", new_sqlite_classes: ["PaymentSignerJournal"] },
            ],
          }
        : { triggers: { crons } }),
      ...(role === "attester"
        ? {}
        : {
            services: [
              {
                binding:
                  role === "relayer"
                    ? "IDENTITY_ATTESTER"
                    : family === "evm"
                      ? "EVM_PAYMENT_EXECUTOR"
                      : "SOLANA_PAYMENT_EXECUTOR",
                service: names[role === "relayer" ? "attester" : "relayer"],
              },
            ],
          }),
    };
  }
  return {
    names,
    configs,
    secret:
      family === "evm"
        ? SIGNER_STACKS[stack].evmSecret
        : SIGNER_STACKS[stack].solanaSecret,
  };
}

async function main() {
  const args = {};
  const allowed = new Set([
    "stack",
    "network",
    "database-id",
    "database-name",
    "deployments",
    "output",
  ]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]?.replace(/^--/, "");
    if (
      !process.argv[index]?.startsWith("--") ||
      !allowed.has(key) ||
      args[key] ||
      !process.argv[index + 1]
    )
      throw new Error(
        "Use [--stack test] --network NETWORK --database-id ID --database-name NAME --deployments PATH --output DIRECTORY, or --stack production --network MAINNET --deployments PATH --output DIRECTORY",
      );
    args[key] = process.argv[index + 1];
  }
  if (!args.deployments || !args.output)
    throw new Error("--deployments and --output are required");
  const stack = args.stack ?? "test";
  const network = args.network;
  const { names, configs, secret } = paymentStack({
    stack,
    network,
    databaseId: args["database-id"],
    databaseName: args["database-name"],
    deployments: JSON.parse(await readFile(args.deployments, "utf8")),
    // The D1 project registry snapshot (`bun run projects:sync`) is the reviewed source.
    registry: HISTORICAL_PROJECTS,
    registryDatabase: await readRegistryDatabase(),
  });
  const output = resolve(args.output);
  await mkdir(output, { recursive: true });
  const paths = {};
  for (const role of ROLES) {
    paths[role] = resolve(output, `${names[role]}.json`);
    await writeFile(paths[role], `${JSON.stringify(configs[role], null, 2)}\n`);
    console.log(paths[role]);
  }
  const inactiveDispatcher = resolve(
    output,
    `${names.dispatcher}-inactive.json`,
  );
  await writeFile(
    inactiveDispatcher,
    `${JSON.stringify({ ...configs.dispatcher, triggers: { crons: [] } }, null, 2)}\n`,
  );
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrangler = quote(resolve(repository, "node_modules/.bin/wrangler"));
  const command = (role, operation) =>
    `${wrangler} ${operation} --config ${quote(paths[role])}`;
  const solana = ESCROW_NETWORKS[network].family === "solana";
  const dispatcherSecrets = [
    command("dispatcher", "secret put PAYMENT_RPC_URLS"),
    ...(solana
      ? [command("dispatcher", "secret put PAYMENT_SOLANA_GENESIS")]
      : []),
  ];
  const signers = ["attester", "relayer"].flatMap((role) => [
    command(role, "deploy"),
    command(role, "secret put PAYMENT_RPC_URLS"),
    command(role, `secret put ${secret}`),
  ]);
  const dryRuns = ROLES.map((role) => command(role, "deploy --dry-run"));
  if (stack === "production") {
    // Operator-run only (contracts/DEPLOY-MAINNET.md section 3.2). The signers
    // refuse this network until its reviewed MAINNET_EXECUTION value is true,
    // and the dispatcher deploys without a cron until then.
    const plan = [
      "#!/bin/sh",
      "set -eu",
      `# Production payment stack for ${network}; secrets are entered at Wrangler prompts.`,
      "# The Pages release migrates the registry database; this script never migrates it.",
      `cd ${quote(repository)}`,
      ...dryRuns,
      ...signers,
      `${wrangler} deploy --config ${quote(inactiveDispatcher)}`,
      ...dispatcherSecrets,
      command("dispatcher", "deploy"),
      "",
    ];
    await writeFile(
      resolve(output, "apply-production-stack.sh"),
      plan.join("\n"),
      { mode: 0o700 },
    );
    return;
  }
  const plan = [
    "#!/bin/sh",
    "set -eu",
    "# Explicit isolated test backend apply; secrets are entered at Wrangler prompts.",
    `cd ${quote(repository)}`,
    ...dryRuns,
    `node ${quote(resolve(root, "assert-fresh-test-stack.mjs"))} ${Object.values(names).map(quote).join(" ")}`,
    command("dispatcher", "d1 migrations apply PAYMENTS_DB --remote"),
    ...signers,
    `${wrangler} deploy --config ${quote(inactiveDispatcher)}`,
    // Fresh-only admission prevents modifying any existing active stack.
    ...dispatcherSecrets,
    command("dispatcher", "deploy"),
    "",
  ];
  await writeFile(resolve(output, "apply-test-backend.sh"), plan.join("\n"), {
    mode: 0o700,
  });
  await writeFile(
    resolve(output, "pages-bindings.json"),
    `${JSON.stringify({ network, note: "Merge only into isolated test Pages environment; never production.", d1_databases: [{ binding: "SLOP_DB", database_name: args["database-name"], database_id: args["database-id"] }], services: [{ binding: "SLOP_IDENTITY", service: "slop-identity-test" }], vars: { PAYMENTS_ALLOWED_ORIGIN: "https://slop-staging.pages.dev", PAYMENT_NETWORKS: JSON.stringify([network]) }, requiredSecretNames: ["TRACE_AUTH_SECRET"], optionalOperatorVariable: "OPERATOR_GITHUB_IDS" }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
