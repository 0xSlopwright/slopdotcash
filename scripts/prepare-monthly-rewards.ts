/**
 * Freezes the previous closed UTC month for every active project and creates
 * review proposals at canonical Git-backed paths. Existing complete cycles are
 * left untouched; partial cycles fail closed for maintainer repair.
 */

import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTS, type ProjectDefinition } from "../src/lib/projects.mjs";
import { prepareEscrowCycle } from "./prepare-escrow-cycle";
import { syncCycleIndex } from "./sync-cycle-index";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CYCLES_ROOT = resolve(REPOSITORY_ROOT, "cycles");
const DEFAULT_SNAPSHOT_PATH = resolve(
  REPOSITORY_ROOT,
  "public/data/leaderboard.json",
);

type ExistingPath = "file" | "missing";

export interface MonthlyRewardResult {
  cycleId: string;
  prepared: string[];
  skippedExisting: string[];
  skippedPrelaunch: string[];
}

export interface PrepareMonthlyCycleArguments {
  cycleId: string;
  generatedAt: string;
  githubToken?: string;
  projectId: string;
  snapshotPath: string;
}

interface MonthlyDependencies {
  inspectPath: (path: string) => Promise<ExistingPath>;
  prepare: (arguments_: PrepareMonthlyCycleArguments) => Promise<unknown>;
  projects: readonly ProjectDefinition[];
  validateCycles: () => Promise<unknown>;
}

function exactDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${field} must be a valid date`);
  }
  return value;
}

function cycleEnd(cycleId: string): number {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(cycleId)) {
    throw new TypeError("cycle must be YYYY-MM");
  }
  const [yearText, monthText] = cycleId.split("-");
  return Date.UTC(Number(yearText), Number(monthText), 1);
}

/** Returns the last fully closed UTC calendar month. */
export function previousUtcCycleId(now = new Date()): string {
  const validNow = exactDate(now, "now");
  const previous = new Date(
    Date.UTC(validNow.getUTCFullYear(), validNow.getUTCMonth() - 1, 1),
  );
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function inspectRegularPath(path: string): Promise<ExistingPath> {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return "missing";
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TypeError(`${path} must be a regular file`);
  }
  return "file";
}

const DEFAULT_DEPENDENCIES: MonthlyDependencies = {
  inspectPath: inspectRegularPath,
  prepare: (arguments_) => prepareEscrowCycle(arguments_),
  projects: PROJECTS,
  validateCycles: () => syncCycleIndex(),
};

export async function prepareMonthlyRewards(
  options: {
    cycleId?: string;
    generatedAt?: string;
    githubToken?: string;
    snapshotPath?: string;
  } = {},
  dependencies: MonthlyDependencies = DEFAULT_DEPENDENCIES,
): Promise<MonthlyRewardResult> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const generatedTime = Date.parse(generatedAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(generatedAt) ||
    !Number.isFinite(generatedTime)
  ) {
    throw new TypeError("generatedAt must be an exact UTC timestamp");
  }
  const cycleId = options.cycleId ?? previousUtcCycleId(new Date(generatedAt));
  const end = cycleEnd(cycleId);
  if (generatedTime < end) {
    throw new RangeError(`Cycle ${cycleId} has not closed`);
  }

  const result: MonthlyRewardResult = {
    cycleId,
    prepared: [],
    skippedExisting: [],
    skippedPrelaunch: [],
  };
  for (const project of dependencies.projects) {
    // Escrow is the only funding mode. A project without an escrow policy
    // effective for this cycle has no payable monthly cycle to prepare.
    if (
      project.status !== "active" ||
      project.authority.state !== "verified" ||
      project.terms.receiptPolicy.state !== "active" ||
      Date.parse(project.reward.rewardStartAt) >= end ||
      !project.escrow ||
      cycleId < project.escrow.effectiveCycle
    ) {
      result.skippedPrelaunch.push(project.id);
      continue;
    }
    const directory = resolve(CYCLES_ROOT, project.id, cycleId, "escrow-v2");
    const [proposalState, snapshotState] = await Promise.all([
      dependencies.inspectPath(resolve(directory, "proposal.json")),
      dependencies.inspectPath(resolve(directory, "source-snapshot.json")),
    ]);
    if (proposalState !== snapshotState) {
      throw new Error(
        `Cycle ${project.id}/${cycleId} is partial; proposal and source snapshot must exist together`,
      );
    }
    if (proposalState === "file") {
      result.skippedExisting.push(project.id);
      continue;
    }
    await dependencies.prepare({
      cycleId,
      generatedAt,
      githubToken: options.githubToken,
      projectId: project.id,
      snapshotPath: options.snapshotPath
        ? resolve(options.snapshotPath)
        : DEFAULT_SNAPSHOT_PATH,
    });
    result.prepared.push(project.id);
  }
  await dependencies.validateCycles();
  return result;
}

function parseArguments(values: string[]): {
  cycleId?: string;
  snapshotPath?: string;
} {
  let cycleId: string | undefined;
  let snapshotPath: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (seen.has(flag)) {
      throw new TypeError(`Repeated monthly reward argument: ${flag}`);
    }
    seen.add(flag);
    const next = values[index + 1];
    if (flag === "--cycle" || flag === "--snapshot") {
      if (!next || next.startsWith("--")) {
        throw new TypeError(`${flag} requires a value`);
      }
      if (flag === "--cycle") cycleId = next;
      else snapshotPath = next;
      index += 1;
    } else {
      throw new TypeError(`Unknown monthly reward argument: ${flag}`);
    }
  }
  return { cycleId, snapshotPath };
}

if (import.meta.main) {
  try {
    const result = await prepareMonthlyRewards({
      ...parseArguments(process.argv.slice(2)),
      githubToken: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    });
    process.stdout.write(
      `[Slop] closed ${result.cycleId}: prepared ${result.prepared.join(", ") || "none"}; already present ${result.skippedExisting.join(", ") || "none"}\n`,
    );
  } catch (error) {
    // error-policy:J1 command boundary exposes a non-zero, actionable failure.
    process.stderr.write(
      `[Slop] monthly close refused: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
