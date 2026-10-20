/**
 * ADM-06 project enforcement rules. A Quarantine or a Ban takes effect
 * through an append-only record at once; the matching paused, retired
 * revision is appended in the same write when the manifest allows it, and is
 * shown as pending when it does not. A restriction can only restrict: it never
 * creates a project, grants featuring, or enables money. Reinstatement needs
 * an appeal and a moderator who did not place the restriction (ELG-02). The
 * project steward or the applicant who listed the project may file the
 * appeal; only a moderator decides it.
 */

import { assertProjectPolicyTransition } from "../../src/lib/project-policy.mjs";
import type { ProjectDefinition } from "../../src/lib/projects.mjs";
import type {
  AppealState,
  EnforcementAction,
  GithubActor,
  ProjectEnforcement,
  ProjectRecord,
  RestrictionState,
} from "./contracts";

export const ENFORCEMENT_ACTIONS: readonly EnforcementAction[] = [
  "quarantine",
  "ban",
  "request_reinstatement",
  "reinstate",
  "deny_reinstatement",
];

export class EnforcementRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ProjectRestriction = {
  projectId: string;
  state: RestrictionState;
  appeal: AppealState;
  /** When the restriction in force began; null when the project is clear. */
  since: string | null;
  /** Moderators who placed the restriction in force. */
  restrictedBy: GithubActor[];
  /** Revision the restriction in force started from. */
  openedAtRevision: number | null;
  repositoryGithubId: string | null;
  repositoryKeys: string[];
  /** The next record's sequence number. */
  nextSequence: number;
  records: ProjectEnforcement[];
};

/** Folds one project's records, oldest first, into its current restriction. */
export function projectRestriction(
  projectId: string,
  all: ProjectEnforcement[],
): ProjectRestriction {
  const records = all
    .filter((record) => record.projectId === projectId)
    .sort((left, right) => left.sequence - right.sequence);
  const restriction: ProjectRestriction = {
    projectId,
    state: "clear",
    appeal: "none",
    since: null,
    restrictedBy: [],
    openedAtRevision: null,
    repositoryGithubId: null,
    repositoryKeys: [],
    nextSequence: records.length + 1,
    records,
  };
  for (const record of records) {
    if (
      (record.action === "quarantine" || record.action === "ban") &&
      restriction.state === "clear"
    ) {
      restriction.since = record.createdAt;
      restriction.restrictedBy = [];
      restriction.openedAtRevision = record.beforeRevision;
    }
    if (record.action === "quarantine" || record.action === "ban") {
      if (
        !restriction.restrictedBy.some(
          (actor) => actor.githubId === record.actor.githubId,
        )
      )
        restriction.restrictedBy.push(record.actor);
    }
    restriction.state = record.stateAfter;
    restriction.appeal = record.appealAfter;
    restriction.repositoryGithubId = record.repositoryGithubId;
    restriction.repositoryKeys = record.repositoryKeys;
    if (record.stateAfter === "clear") {
      restriction.since = null;
      restriction.restrictedBy = [];
      restriction.openedAtRevision = null;
    }
  }
  return restriction;
}

/** Current restrictions of every project that is not clear. */
export function activeRestrictions(
  records: ProjectEnforcement[],
): ProjectRestriction[] {
  return [...new Set(records.map((record) => record.projectId))]
    .map((projectId) => projectRestriction(projectId, records))
    .filter((restriction) => restriction.state !== "clear");
}

/** Repository identities a manifest claims: the GitHub id and every path. */
export function repositoryIdentity(manifest: ProjectDefinition): {
  githubId: string;
  keys: string[];
} {
  return {
    githubId: String(manifest.authority.repositoryId),
    keys: [
      ...new Set(
        manifest.repositories.flatMap((repository) =>
          [repository.id, ...(repository.aliases ?? [])].map((path) =>
            path.toLowerCase(),
          ),
        ),
      ),
    ],
  };
}

/** The restriction in force on any repository this manifest claims. */
export function restrictionForRepository(
  manifest: ProjectDefinition,
  records: ProjectEnforcement[],
): ProjectRestriction | null {
  const identity = repositoryIdentity(manifest);
  return (
    activeRestrictions(records).find(
      (restriction) =>
        restriction.repositoryGithubId === identity.githubId ||
        restriction.repositoryKeys.some((key) => identity.keys.includes(key)),
    ) ?? null
  );
}

/** A restricted project must stay paused and out of every listing. */
export function enforcedManifest(manifest: ProjectDefinition): boolean {
  return manifest.status === "paused" && manifest.listingTier === "retired";
}

export type EnforcementPlan = {
  stateAfter: RestrictionState;
  appealAfter: AppealState;
  /** The manifest the matching revision appends, or null when none is due. */
  manifest: ProjectDefinition | null;
  /** Why a due revision cannot be appended yet. */
  pendingReason: string | null;
};

function refuse(code: string, message: string): never {
  throw new EnforcementRefusal(409, code, message);
}

function revisionTo(
  current: ProjectDefinition,
  next: ProjectDefinition,
): Pick<EnforcementPlan, "manifest" | "pendingReason"> {
  if (
    current.status === next.status &&
    current.listingTier === next.listingTier
  )
    return { manifest: null, pendingReason: null };
  try {
    assertProjectPolicyTransition(current, next);
  } catch (error) {
    return {
      manifest: null,
      pendingReason:
        error instanceof Error
          ? error.message
          : "The current manifest does not pass validation",
    };
  }
  return { manifest: next, pendingReason: null };
}

/**
 * Validates one action against the current restriction and plans the
 * matching revision. `listedBefore` is the listing tier of the revision the
 * restriction started from; reinstatement never restores more than the
 * community tier.
 */
export function planEnforcement(input: {
  action: EnforcementAction;
  actor: GithubActor;
  project: ProjectRecord;
  restriction: ProjectRestriction;
  listedBefore: boolean;
}): EnforcementPlan {
  const { action, actor, project, restriction } = input;
  const manifest = project.manifest;
  switch (action) {
    case "quarantine":
    case "ban": {
      if (action === "quarantine" && restriction.state !== "clear")
        refuse(
          "already_restricted",
          `The project is already ${restriction.state}`,
        );
      if (action === "ban" && restriction.state === "banned")
        refuse("already_restricted", "The project is already banned");
      return {
        stateAfter: action === "ban" ? "banned" : "quarantined",
        // An escalation keeps an open appeal open for independent review.
        appealAfter: restriction.appeal === "requested" ? "requested" : "none",
        ...revisionTo(manifest, {
          ...manifest,
          status: "paused",
          listingTier: "retired",
        }),
      };
    }
    case "request_reinstatement":
      if (restriction.state === "clear")
        refuse("not_restricted", "The project has no restriction to appeal");
      if (restriction.appeal === "requested")
        refuse("appeal_open", "A reinstatement request is already open");
      return {
        stateAfter: restriction.state,
        appealAfter: "requested",
        manifest: null,
        pendingReason: null,
      };
    case "reinstate":
    case "deny_reinstatement": {
      if (restriction.state === "clear" || restriction.appeal !== "requested")
        refuse(
          "no_open_appeal",
          "Record a reinstatement request before a decision",
        );
      if (
        restriction.restrictedBy.some(
          (placed) => placed.githubId === actor.githubId,
        )
      )
        throw new EnforcementRefusal(
          403,
          "independent_review_required",
          "A moderator who did not place this restriction must decide the appeal",
        );
      if (action === "deny_reinstatement")
        return {
          stateAfter: restriction.state,
          appealAfter: "denied",
          manifest: null,
          pendingReason: null,
        };
      // A restriction whose paused, retired revision is still pending must
      // not clear: clearing it would restore the listed or active manifest.
      if (!enforcedManifest(manifest))
        refuse(
          "revision_pending",
          "Append the paused, retired revision of this restriction before reinstatement",
        );
      // Reinstatement lists the project again only if the restriction found
      // it listed, never above the community tier, and always paused.
      return {
        stateAfter: "clear",
        appealAfter: "granted",
        ...(input.listedBefore && manifest.listingTier === "retired"
          ? revisionTo(manifest, {
              ...manifest,
              status: "paused",
              listingTier: "community",
            })
          : { manifest: null, pendingReason: null }),
      };
    }
  }
}

/** The public reason text of the revision an action appends. */
export function enforcementRevisionReason(
  action: EnforcementAction,
  recordId: string,
): string {
  const label =
    action === "reinstate"
      ? "Reinstated after independent review"
      : action === "ban"
        ? "Banned by a project moderator"
        : "Quarantined by a project moderator";
  return `${label} (${recordId})`;
}
