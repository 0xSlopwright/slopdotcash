/**
 * Reproduces a generated project skill from this checkout's template commit
 * and one public manifest revision, so anyone can compare its digest and
 * archive with what slop.cash serves.
 *
 *   node scripts/render-project-skill.mjs --project <id> --revision <n> \
 *     [--origin https://slop.cash] [--out <directory>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHistoricalProjectDefinition } from "../src/lib/project-schema.mjs";
import {
  CONTRIBUTOR_TEMPLATE_PATH,
  REVIEWER_TEMPLATE_PATH,
  renderProjectSkills,
  SKILL_KIT_FILES,
  SKILL_KIT_PATH,
  sha256Hex,
  skillManifest,
} from "../src/lib/project-skill-render.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback !== undefined) return fallback;
    throw new TypeError(`${name} is required`);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new TypeError(`${name} needs a value`);
  return value;
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function group(sourcePath, files) {
  const paths =
    files ??
    git(["ls-files", "--", sourcePath])
      .split("\n")
      .filter(Boolean)
      .map((path) => path.slice(sourcePath.length + 1))
      .sort();
  return {
    sourcePath,
    files: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: await sha256Hex(readFileSync(join(root, sourcePath, path))),
      })),
    ),
  };
}

const projectId = option("--project");
const revision = Number(option("--revision"));
const origin = option("--origin", "https://slop.cash").replace(/\/$/u, "");
const out = option("--out", "");
if (!Number.isSafeInteger(revision) || revision < 1)
  throw new TypeError("--revision must be a positive integer");

const commit = git(["rev-parse", "HEAD"]);
const clean =
  git([
    "status",
    "--porcelain",
    "--",
    CONTRIBUTOR_TEMPLATE_PATH,
    REVIEWER_TEMPLATE_PATH,
    SKILL_KIT_PATH,
  ]) === "";
const response = await fetch(`${origin}/api/v1/project-revisions`, {
  headers: { accept: "application/json" },
});
if (!response.ok)
  throw new Error(`Revision history returned HTTP ${response.status}`);
const history = await response.json();
const entry = history.revisions?.find(
  (candidate) =>
    candidate.projectId === projectId && candidate.revision === revision,
);
if (!entry) throw new Error(`No revision ${revision} of ${projectId}`);
const manifestText = JSON.stringify(entry.manifest);
if ((await sha256Hex(manifestText)) !== entry.manifestSha256)
  throw new Error("The published manifest does not match its SHA-256");
const rendered = await renderProjectSkills({
  template: {
    schemaVersion: "1",
    repository: "SlopDotCash/slopdotcash",
    commit,
    revisionStatus: clean ? "committed" : "working-tree",
    contributor: await group(CONTRIBUTOR_TEMPLATE_PATH),
    reviewer: await group(REVIEWER_TEMPLATE_PATH),
    scripts: await group(SKILL_KIT_PATH, [...SKILL_KIT_FILES]),
  },
  readFile: async (path) => new Uint8Array(readFileSync(join(root, path))),
  manifest: assertHistoricalProjectDefinition(entry.manifest),
  revision,
  manifestSha256: entry.manifestSha256,
  publicOrigin: origin,
});
for (const [review, skill] of [
  [false, rendered.contributor],
  [true, rendered.reviewer],
]) {
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${skill.name}.skill`), skill.archive);
  }
  console.log(
    JSON.stringify(
      skillManifest(skill, { publicOrigin: origin, projectId, review }),
      null,
      2,
    ),
  );
}
