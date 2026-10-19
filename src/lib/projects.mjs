/**
 * Defines the public project registry and launch reward policies. Project
 * instructions may evolve in their repositories, while financial and trust
 * fields change only through review in this registry.
 */

import LEGACY_PROJECTS from "./legacy-projects.json" with { type: "json" };
import { RAW_PROJECT_DEFINITIONS } from "./project-registry.generated.mjs";
import { assertProjectRegistry } from "./project-schema.mjs";

function freezeTree(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

function compareMinorDescending(left, right) {
  const leftMinor = BigInt(left);
  const rightMinor = BigInt(right);
  return leftMinor === rightMinor ? 0 : leftMinor > rightMinor ? -1 : 1;
}

/** Every manifest, including retired ones kept only to resolve history. */
const HISTORICAL_PROJECTS = Object.freeze(
  assertProjectRegistry(RAW_PROJECT_DEFINITIONS)
    .sort(
      (left, right) =>
        compareMinorDescending(
          left.reward.committedMinor,
          right.reward.committedMinor,
        ) ||
        compareMinorDescending(
          left.reward.monthlyCapMinor,
          right.reward.monthlyCapMinor,
        ) ||
        // Equal pools keep the root publisher first, so a cap change alone
        // cannot move the primary leaderboard repository.
        Number(right.skill.publishAtRoot === true) -
          Number(left.skill.publishAtRoot === true) ||
        left.id.localeCompare(right.id),
    )
    .map(freezeTree),
);

/** Listed projects. Retired manifests never reach a page, skill, or list. */
const PROJECTS = Object.freeze(
  HISTORICAL_PROJECTS.filter((project) => project.listingTier !== "retired"),
);

const PROJECTS_BY_ID = new Map(
  PROJECTS.map((project) => [project.id, project]),
);
const PROJECTS_BY_REPOSITORY = new Map(
  PROJECTS.flatMap((project) =>
    project.repositories.flatMap((repository) =>
      [repository.id, ...(repository.aliases ?? [])].map((repositoryId) => [
        repositoryId.toLowerCase(),
        project,
      ]),
    ),
  ),
);

const HISTORICAL_PROJECTS_BY_ID = new Map(
  HISTORICAL_PROJECTS.map((project) => [project.id, project]),
);
const HISTORICAL_PROJECTS_BY_REPOSITORY = new Map(
  HISTORICAL_PROJECTS.flatMap((project) =>
    project.repositories.flatMap((repository) =>
      [repository.id, ...(repository.aliases ?? [])].map((repositoryId) => [
        repositoryId.toLowerCase(),
        project,
      ]),
    ),
  ),
);

/** Resolves a project id in immutable history, including retired projects. */
export function findHistoricalProject(projectId) {
  if (typeof projectId !== "string") return null;
  return HISTORICAL_PROJECTS_BY_ID.get(projectId) ?? null;
}

/** Resolves a repository in immutable history, including retired projects. */
export function findHistoricalProjectByRepositoryId(repositoryId) {
  if (typeof repositoryId !== "string") return null;
  return (
    HISTORICAL_PROJECTS_BY_REPOSITORY.get(repositoryId.toLowerCase()) ?? null
  );
}

/**
 * Projects listed before the D1 registry were removed with their manifests.
 * Contributor points and profiles keep their ids and repositories as history
 * labels only; they are never listed, collected, scored, or paid.
 */
const LEGACY_PROJECT_IDS = new Set(
  LEGACY_PROJECTS.map((project) => project.id),
);
const HISTORY_REPOSITORIES = new Map(
  [
    ...LEGACY_PROJECTS.map((project) => ({
      id: project.id,
      repositories: project.repositories,
    })),
    ...HISTORICAL_PROJECTS,
  ].flatMap((project) =>
    project.repositories.flatMap((repository) =>
      [repository.id, ...(repository.aliases ?? [])].map((repositoryId) => [
        repositoryId.toLowerCase(),
        { projectId: project.id, repositoryId: repository.id },
      ]),
    ),
  ),
);

/** True for a registry project or a removed pre-registry project id. */
export function isHistoricalProjectId(projectId) {
  return (
    typeof projectId === "string" &&
    (HISTORICAL_PROJECTS_BY_ID.has(projectId) ||
      LEGACY_PROJECT_IDS.has(projectId))
  );
}

/**
 * Resolves a registry or removed pre-registry repository id or alias to its
 * owning project id and canonical repository id.
 */
export function findHistoricalRepository(repositoryId) {
  if (typeof repositoryId !== "string") return null;
  return HISTORY_REPOSITORIES.get(repositoryId.toLowerCase()) ?? null;
}

/** True for a registry repository or a removed pre-registry repository. */
export function isHistoricalRepositoryId(repositoryId) {
  return findHistoricalRepository(repositoryId) !== null;
}

/** Returns the canonical project for an id or slug. */
export function findProject(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (
    PROJECTS_BY_ID.get(normalized) ??
    PROJECTS.find((project) => project.slug.toLowerCase() === normalized) ??
    null
  );
}

/** Returns the project owning a registered repository id. */
export function findProjectByRepositoryId(repositoryId) {
  if (typeof repositoryId !== "string") return null;
  return PROJECTS_BY_REPOSITORY.get(repositoryId.toLowerCase()) ?? null;
}

/** Refuses every money-state transition until a reviewed project enables it. */
export function assertProjectPaymentsEnabled(projectId, cycleId) {
  const project = findProject(projectId);
  if (
    project?.reward.kind !== "monthly-pool" ||
    project.reward.paymentMode !== "enabled" ||
    project.reward.fundingState !== "committed" ||
    BigInt(project.reward.committedMinor) <= 0n
  ) {
    throw new TypeError(`Payments are disabled for project ${projectId}`);
  }
  if (
    !project.funding.freshCyclePaymentPolicy ||
    project.funding.freshCyclePaymentPolicy.cycleId !== cycleId
  )
    throw new TypeError(
      `Payments require the exact reviewed fresh cycle for project ${projectId}`,
    );
  return project;
}

export { HISTORICAL_PROJECTS, PROJECTS };
