import { readFile } from "node:fs/promises";

/**
 * The D1 database that holds the project registry: the top-level `SLOP_DB`
 * binding of the Pages `wrangler.toml` (`slop-private`). The payments
 * dispatcher binds it as `REGISTRY_DB` and only reads it. An isolated payment
 * database has its own empty `projects` table, so binding it in its place
 * would find no vaults. A missing or repeated binding stops the caller.
 */
export function parseRegistryDatabase(toml) {
  const found = [];
  let block;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      block = line === "[[d1_databases]]" ? {} : undefined;
      if (block) found.push(block);
      continue;
    }
    const match = block && /^([a-z_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (match) block[match[1]] = match[2];
  }
  const registry = found.filter((entry) => entry.binding === "SLOP_DB");
  if (
    registry.length !== 1 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(registry[0].database_name ?? "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      registry[0].database_id ?? "",
    )
  )
    throw new Error("wrangler.toml must bind exactly one registry SLOP_DB");
  return {
    database_name: registry[0].database_name,
    database_id: registry[0].database_id,
  };
}

/** The registry database of this repository's Pages configuration. */
export async function readRegistryDatabase() {
  return parseRegistryDatabase(
    await readFile(new URL("../../wrangler.toml", import.meta.url), "utf8"),
  );
}
