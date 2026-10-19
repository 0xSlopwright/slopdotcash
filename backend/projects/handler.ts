import {
  type DeploymentTier,
  deploymentOrigins,
} from "../../src/lib/deployment";
import type {
  ProjectApplicationNotice as AdminApplicationNotice,
  EnforcementPreview,
  ProjectEnforcementState,
  PublicProjectApplication,
} from "../../src/lib/project-contracts";
import { validRepositoryPath } from "../../src/lib/project-contracts";
import { assertProjectPolicyTransition } from "../../src/lib/project-policy.mjs";
import {
  assertProjectDefinition,
  assertProjectRegistry,
  PROJECT_SKILL_TEMPLATES,
} from "../../src/lib/project-schema.mjs";
import { publishesGeneratedSkills } from "../../src/lib/project-skill.mjs";
import type { ProjectDefinition } from "../../src/lib/projects.mjs";
import {
  REWARD_ASSET_NETWORKS,
  type RewardAsset,
  rewardAssetChoice,
  sameRewardAsset,
} from "../../src/lib/reward-asset.mjs";
import { type ApiError, fail } from "../api-error";
import { pathParts } from "../api-path";
import { readJsonObject, sha256Hex } from "../trace/validation";
import type { VettingClearance } from "../vetting/persistence";
import {
  type ApplicationStatus,
  type EnforcementAction,
  type EnforcementActorRole,
  type GithubActor,
  MAX_PENDING_APPLICATIONS_PER_APPLICANT,
  PROJECT_API_CONTRACT_VERSION,
  type ProjectApplication,
  type ProjectEnforcement,
  type ProjectPersistence,
  type ProjectRecord,
  type RepositoryControl,
  type WebSession,
} from "./contracts";
import {
  cachedPublicResponse,
  type EdgeCache,
  PUBLIC_PROJECT_CACHE_CONTROL,
  purgeProjectCache,
} from "./edge-cache";
import {
  activeRestrictions,
  ENFORCEMENT_ACTIONS,
  enforcedManifest,
  enforcementRevisionReason,
  type ProjectRestriction,
  planEnforcement,
  projectRestriction,
  publicRestrictionOf,
  repositoryIdentity,
  restrictionForRepository,
  sameRepositoryIdentity,
} from "./enforcement";
import {
  type GithubFetch,
  GithubLookupError,
  listOwnedRepositories,
  lookupGitHubActor,
  lookupGitHubRepository,
  validGithubLogin,
} from "./github-lookup";
import { TokenMetadataError, type TokenMetadataReader } from "./token-metadata";

export type { ProjectApplicationNotice as AdminApplicationNotice } from "../../src/lib/project-contracts";

export type ProjectApiDependencies = {
  tier?: DeploymentTier;
  persistence: ProjectPersistence;
  adminGithubIds: ReadonlySet<string>;
  /** GitHub actor IDs with the project moderation role (PRD ADM-05, ADM-06). */
  moderatorGithubIds: ReadonlySet<string>;
  now: () => Date;
  randomId: () => string;
  /** Resolves the GitHub account behind the site sign-in session cookie. */
  sessionActor: (request: Request) => Promise<GithubActor | null>;
  /** Resolves true only when every admin was emailed. */
  notifyAdmins: (notice: AdminApplicationNotice) => Promise<boolean>;
  /** Reads a reward token's decimals from chain once, at submission or change. */
  readTokenMetadata: TokenMetadataReader;
  /** Public GitHub reads for the setup form, with an optional server token. */
  github: { fetch: GithubFetch; token?: string; apiOrigin?: string };
  /** Edge cache for public reads; absent in tests and local tooling. */
  cache?: EdgeCache;
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Security vetting of a manifest's executable content through a revision
   * (PRD VET-01). Only "cleared" lets a revision activate or serve skills.
   */
  vettingClearance: (
    projectId: string,
    manifest: ProjectDefinition,
    throughRevision: number,
    forReinstatement?: boolean,
  ) => Promise<VettingClearance>;
  /** Asks GitHub whether the applicant controls the manifest's repository. */
  repositoryControl: (
    manifest: ProjectDefinition,
    actor: GithubActor,
  ) => Promise<RepositoryControl>;
};

const APPLICATION_ID = /^app_[A-Za-z0-9_-]{8,72}$/u;
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;

function json(
  status: number,
  body: Record<string, unknown>,
  cacheControl = "no-store",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-slop-project-api-contract": PROJECT_API_CONTRACT_VERSION,
    },
  });
}

function boundedText(
  value: unknown,
  name: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string")
    fail(400, "invalid_request", `Invalid ${name}`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    fail(400, "invalid_request", `${name} must be ${min} to ${max} characters`);
  }
  return trimmed;
}

function exactKeys(
  body: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(body, key)) ||
    Object.keys(body).some((key) => !allowed.has(key))
  ) {
    fail(400, "invalid_request", "Request body has unexpected fields");
  }
}

function invalidManifest(error: unknown): never {
  fail(
    422,
    "invalid_manifest",
    error instanceof Error ? error.message : "Project manifest is invalid",
  );
}

function canonicalManifest(value: unknown): {
  manifest: ProjectDefinition;
  text: string;
} {
  let manifest: ProjectDefinition;
  try {
    manifest = assertProjectDefinition(value) as ProjectDefinition;
  } catch (error) {
    invalidManifest(error);
  }
  return { manifest, text: JSON.stringify(manifest) };
}

/**
 * A new application may only describe an unverified, paused, unfunded
 * community project. Authority, terms, listing tier, skills, and money arrive
 * later through admin revisions.
 */
function assertApplicationManifest(manifest: ProjectDefinition): void {
  const reward = manifest.reward;
  const reviewBudget =
    reward.kind === "monthly-pool" ? reward.reviewBudget : undefined;
  const rules: [boolean, string][] = [
    [manifest.status === "paused", "New projects must start paused"],
    [
      manifest.listingTier === "community",
      "New projects are listed in the community tier",
    ],
    [
      manifest.skill.publishAtRoot === false,
      "Only an admin can publish a project skill at the site root",
    ],
    [
      manifest.skill.sourcePath === PROJECT_SKILL_TEMPLATES.contributor &&
        manifest.reviewSkill.sourcePath === PROJECT_SKILL_TEMPLATES.reviewer,
      "New projects use generated skills from the canonical templates",
    ],
    [
      manifest.authority.state === "unverified" &&
        manifest.authority.proof === null,
      "Repository authority is verified after approval",
    ],
    [
      manifest.terms.receiptPolicy.state === "pending-authority-activation",
      "Receipt policy activates only after authority verification",
    ],
    [manifest.terms.externalPrize === null, "External prizes need admin setup"],
    [
      reward.kind === "monthly-pool" &&
        reward.paymentMode === "disabled" &&
        reward.committedMinor === "0" &&
        reward.fundingState === "pledged" &&
        (reviewBudget === undefined ||
          (reviewBudget.paymentMode === "disabled" &&
            reviewBudget.committedMinor === "0" &&
            reviewBudget.fundingState === "pledged")),
      "Applications may only pledge a monthly pool with payments disabled",
    ],
    [
      (manifest.funding.addresses ?? []).length === 0 &&
        (manifest.escrow?.deployments ?? []).length === 0,
      "Funding addresses and escrow deployments need admin verification",
    ],
    [
      manifest.securityBounty === undefined ||
        (manifest.securityBounty.status === "pending-approval" &&
          manifest.securityBounty.funding.state === "pledged"),
      "A security bounty program starts pending approval with pledged funding",
    ],
  ];
  for (const [valid, message] of rules) {
    if (!valid) fail(422, "invalid_manifest", message);
  }
}

/**
 * Replaces a submitted reward asset with its verified form. An unchanged
 * asset keeps its stored decimals; a new or changed one is read from chain
 * once. The paid symbol and network of the pool follow the asset.
 */
async function verifiedRewardAsset(
  value: unknown,
  prior: RewardAsset | undefined,
  deps: ProjectApiDependencies,
): Promise<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  const manifest = value as Record<string, unknown>;
  if (!Object.hasOwn(manifest, "rewardAsset")) return value;
  const submitted = manifest.rewardAsset as Record<string, unknown> | null;
  let choice: ReturnType<typeof rewardAssetChoice>;
  try {
    choice = rewardAssetChoice(
      String(submitted?.network ?? ""),
      String(submitted?.kind ?? ""),
      String(submitted?.address ?? ""),
      String(submitted?.symbol ?? ""),
    );
  } catch (error) {
    invalidManifest(error);
  }
  const network = REWARD_ASSET_NETWORKS[choice.network];
  let asset: RewardAsset;
  if (prior !== undefined && sameRewardAsset(prior, choice as RewardAsset)) {
    asset = prior;
  } else if (choice.kind === "stablecoin") {
    asset = {
      ...choice,
      decimals: network.stablecoin.decimals,
      chainId: network.chainId,
      cluster: network.cluster,
      verifiedAt: deps.now().toISOString(),
    };
  } else {
    let metadata: Awaited<ReturnType<TokenMetadataReader>>;
    try {
      metadata = await deps.readTokenMetadata(choice.network, choice.address);
    } catch (error) {
      fail(
        error instanceof TokenMetadataError ? 422 : 503,
        "reward_asset_unverified",
        error instanceof TokenMetadataError
          ? `The reward token could not be verified on ${network.name}: ${error.message}`
          : `${network.name} could not be reached to verify the reward token. Try again.`,
      );
    }
    asset = {
      ...choice,
      symbol: metadata.symbol ?? choice.symbol,
      decimals: metadata.decimals,
      chainId: network.chainId,
      cluster: network.cluster,
      verifiedAt: deps.now().toISOString(),
    };
  }
  const reward = manifest.reward as Record<string, unknown> | undefined;
  return {
    ...manifest,
    rewardAsset: asset,
    ...(reward?.kind === "monthly-pool"
      ? { reward: { ...reward, chain: asset.network, currency: asset.symbol } }
      : {}),
  };
}

function skillNames(manifest: ProjectDefinition): string[] {
  return [manifest.skill.id, manifest.reviewSkill.id];
}

/**
 * A review budget added or newly funded may not shrink the contributor pool
 * or reach back into an open or closed cycle.
 */
function assertReviewBudgetTransition(
  prior: ProjectDefinition,
  next: ProjectDefinition,
  now: Date,
): void {
  if (
    prior.reward.kind !== "monthly-pool" ||
    next.reward.kind !== "monthly-pool"
  )
    return;
  const priorBudget = prior.reward.reviewBudget;
  const nextBudget = next.reward.reviewBudget;
  if (!nextBudget) return;
  const changesBudget =
    !priorBudget ||
    (priorBudget.fundingState !== "committed" &&
      nextBudget.fundingState === "committed");
  if (!changesBudget) return;
  if (
    BigInt(next.reward.monthlyCapMinor) < BigInt(prior.reward.monthlyCapMinor)
  ) {
    fail(
      422,
      "invalid_manifest",
      "A review budget cannot be added or funded while the contributor pool cap shrinks",
    );
  }
  const nextCycle = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  if (Date.parse(nextBudget.effectiveAt) < nextCycle) {
    fail(
      422,
      "invalid_manifest",
      "A review budget cannot affect an open or past cycle",
    );
  }
}

/**
 * Checks the candidate against the live registry. Only a manifest revision or a reviewed update application
 * replaces the listed project with the same id; a new application or an
 * approval must conflict with a listed project that already has that id.
 */
function assertRegistryWith(
  projects: ProjectRecord[],
  candidate: ProjectDefinition,
  { replaces }: { replaces: boolean },
): void {
  try {
    assertProjectRegistry([
      ...projects
        .filter((project) => !replaces || project.id !== candidate.id)
        .map((project) => project.manifest),
      candidate,
    ]);
  } catch (error) {
    fail(
      409,
      "registry_conflict",
      error instanceof Error ? error.message : "Project conflicts",
    );
  }
}

function publicApplication(
  application: ProjectApplication,
): PublicProjectApplication {
  return {
    id: application.id,
    projectId: application.projectId,
    repository: application.manifest.repositories[0]?.id ?? null,
    manifest: application.manifest,
    manifestSha256: application.manifestSha256,
    acceptanceCriteria: application.acceptanceCriteria,
    applicant: application.applicant,
    submittedAt: application.submittedAt,
    status: application.status,
    adminNotification: application.adminNotification,
    adminNotificationAt: application.adminNotificationAt,
    decidedAt: application.decidedAt,
    decidedBy: application.decidedBy,
    decisionReason: application.decisionReason,
    githubCheck: application.githubCheck,
    expectedRevision: application.expectedRevision,
    changeReason: application.changeReason,
    referrer: application.referrer,
  };
}

function adminProject(project: ProjectRecord): ProjectRecord {
  return {
    id: project.id,
    status: project.status,
    revision: project.revision,
    manifestSha256: project.manifestSha256,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sourceApplicationId: project.sourceApplicationId,
    referrer: project.referrer,
    manifest: project.manifest,
  };
}

function sessionBody(
  actor: GithubActor,
  deps: ProjectApiDependencies,
): WebSession {
  return { ...actor, admin: deps.adminGithubIds.has(actor.githubId) };
}

async function requireSession(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<WebSession> {
  const actor = await deps.sessionActor(request);
  if (actor === null) fail(401, "unauthorized", "Sign in with GitHub");
  return sessionBody(actor, deps);
}

async function requireAdmin(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<WebSession> {
  const session = await requireSession(request, deps);
  if (!session.admin) fail(403, "forbidden", "Admin access is required");
  return session;
}

async function repositoryControl(
  deps: ProjectApiDependencies,
  manifest: ProjectDefinition,
  actor: GithubActor,
): Promise<RepositoryControl> {
  try {
    return await deps.repositoryControl(manifest, actor);
  } catch {
    // An unavailable lookup never lists a project; an admin decides instead.
    return { state: "unproven", reason: "GitHub could not be checked" };
  }
}

/**
 * Resolves the referrer an applicant named (PRJ-05). The login must belong
 * to an account that has signed in to slop.cash, and it cannot be the
 * applicant, the manifest steward or a Slop team account. A refused referral
 * fails the submission with the reason, so the applicant can clear it or
 * fix it; it is never dropped silently.
 */
async function resolveReferrer(
  value: unknown,
  manifest: ProjectDefinition,
  applicant: GithubActor,
  deps: ProjectApiDependencies,
): Promise<GithubActor | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !validGithubLogin(value))
    fail(422, "invalid_referrer", "The referrer must be a GitHub login.");
  const referrer = await lookupGitHubActor(
    deps.github.fetch,
    deps.github.token,
    value,
    deps.github.apiOrigin,
  );
  if (
    referrer === null ||
    !(await deps.persistence.hasSignedInActor(referrer.githubId))
  )
    fail(
      422,
      "invalid_referrer",
      `@${value} has not signed in to slop.cash, so they cannot be recorded as the referrer. Clear the referral or ask them to sign in first.`,
    );
  if (referrer.githubId === applicant.githubId)
    fail(422, "invalid_referrer", "You cannot refer your own project.");
  if (
    referrer.githubId === manifest.steward.github.actorId ||
    referrer.githubLogin.toLowerCase() ===
      manifest.steward.github.login.toLowerCase()
  )
    fail(
      422,
      "invalid_referrer",
      "The project steward cannot be recorded as its referrer.",
    );
  if (
    deps.adminGithubIds.has(referrer.githubId) ||
    deps.moderatorGithubIds.has(referrer.githubId)
  )
    fail(
      422,
      "invalid_referrer",
      "Slop team accounts cannot be recorded as referrers.",
    );
  return referrer;
}

async function submitApplication(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<Response> {
  const session = await requireSession(request, deps);
  const body = await readJsonObject(request);
  exactKeys(body, ["manifest"], ["expectedRevision", "reason", "referrer"]);
  const proposedId = (body.manifest as { id?: unknown } | null)?.id;
  const current =
    body.expectedRevision === undefined
      ? null
      : typeof proposedId === "string"
        ? await deps.persistence.getProject(proposedId)
        : null;
  if (
    body.expectedRevision !== undefined &&
    (!current || current.revision !== body.expectedRevision)
  )
    fail(
      409,
      "stale_revision",
      "Reload the project before proposing an update",
    );
  const { manifest, text } = canonicalManifest(
    await verifiedRewardAsset(
      body.manifest,
      current?.manifest.rewardAsset,
      deps,
    ),
  );
  if (current) {
    if (manifest.status !== "paused")
      fail(
        422,
        "invalid_manifest",
        "Content updates must be reviewed while paused",
      );
    if (!sameRepositoryIdentity(current.manifest, manifest))
      fail(
        422,
        "invalid_manifest",
        "A project update cannot change repository identity",
      );
    try {
      assertProjectPolicyTransition(current.manifest, manifest);
    } catch (error) {
      invalidManifest(error);
    }
  } else assertApplicationManifest(manifest);
  assertRepositoryUnrestricted(
    manifest,
    await deps.persistence.listEnforcements(),
  );
  const actor = {
    githubId: session.githubId,
    githubLogin: session.githubLogin,
  };
  if (current && body.referrer !== undefined)
    fail(
      422,
      "invalid_referrer",
      "A project update cannot change its referrer.",
    );
  const referrer = current
    ? current.referrer
    : await resolveReferrer(body.referrer, manifest, actor, deps);
  if (
    (await deps.persistence.countPendingApplications(session.githubId)) >=
    MAX_PENDING_APPLICATIONS_PER_APPLICANT
  ) {
    fail(
      429,
      "too_many_pending",
      `You already have ${MAX_PENDING_APPLICATIONS_PER_APPLICANT} applications awaiting review`,
    );
  }
  assertRegistryWith(await deps.persistence.listProjects(), manifest, {
    replaces: current !== null,
  });
  const control = await repositoryControl(deps, manifest, actor);
  if (control.state === "mismatch" || (current && control.state !== "proven"))
    fail(422, "invalid_manifest", control.reason);
  const repository = manifest.repositories[0].id;
  const application: ProjectApplication & { manifestText: string } = {
    ...(current
      ? {
          expectedRevision: current.revision,
          changeReason: boundedText(body.reason, "reason", 1, 1000),
        }
      : {}),
    id: `app_${deps.randomId().replaceAll("-", "")}`,
    projectId: manifest.id,
    repositoryKey: repository.toLowerCase(),
    manifest,
    manifestText: text,
    manifestSha256: await sha256Hex(new TextEncoder().encode(text)),
    acceptanceCriteria: (manifest.contribution?.approvedScope ?? "").slice(
      0,
      1000,
    ),
    applicant: actor,
    submittedAt: deps.now().toISOString(),
    status: "pending",
    adminNotification: "pending",
    adminNotificationAt: null,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    // Every application waits for an admin; the check informs that review.
    githubCheck:
      `${control.state === "proven" ? "Proven" : "Not proven"}: ${control.reason}`.slice(
        0,
        300,
      ),
    referrer,
  };
  if ((await deps.persistence.createApplication(application)) === "conflict") {
    fail(
      409,
      "application_exists",
      "This project or repository already has an application awaiting review",
    );
  }
  let notified = false;
  try {
    notified = await deps.notifyAdmins({
      applicationId: application.id,
      projectId: application.projectId,
      projectName: manifest.name,
      repository,
      applicantLogin: session.githubLogin,
      submittedAt: application.submittedAt,
      reviewUrl: `${deploymentOrigins(deps.tier).site}/admin/applications/${application.id}`,
    });
  } catch {
    // The application is already stored; the failed email stays visible to
    // admins in the review queue instead of failing the submission.
    console.error("project application admin notification failed");
  }
  await deps.persistence.recordAdminNotification(
    application.id,
    notified ? "sent" : "failed",
    deps.now().toISOString(),
  );
  const stored = await deps.persistence.getApplication(application.id);
  if (stored === null) fail(500, "internal_error", "Application vanished");
  return json(201, {
    application: publicApplication(stored),
  });
}

async function listMyApplications(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<Response> {
  const session = await requireSession(request, deps);
  const applications = await deps.persistence.listApplicantApplications(
    session.githubId,
  );
  return json(200, { applications: applications.map(publicApplication) });
}

async function listAdminApplications(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<Response> {
  await requireAdmin(request, deps);
  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  if (!["pending", "approved", "rejected"].includes(status)) {
    fail(400, "invalid_request", "Invalid application status");
  }
  const applications = await deps.persistence.listApplications(
    status as ApplicationStatus,
  );
  return json(200, { applications: applications.map(publicApplication) });
}

async function decideApplication(
  request: Request,
  deps: ProjectApiDependencies,
  applicationId: string,
  decision: "approve" | "reject",
): Promise<Response> {
  const session = await requireAdmin(request, deps);
  if (!APPLICATION_ID.test(applicationId)) {
    fail(404, "not_found", "Application not found");
  }
  const body = await readJsonObject(request);
  exactKeys(body, decision === "reject" ? ["reason"] : [], ["reason"]);
  const reason =
    decision === "reject" || (body.reason !== undefined && body.reason !== "")
      ? boundedText(body.reason, "reason", 1, 1000)
      : null;
  const application = await deps.persistence.getApplication(applicationId);
  if (application === null) fail(404, "not_found", "Application not found");
  if (application.status !== "pending") {
    fail(
      409,
      "already_decided",
      `Application was already ${application.status}`,
    );
  }
  const actor = {
    githubId: session.githubId,
    githubLogin: session.githubLogin,
  };
  const at = deps.now().toISOString();
  if (decision === "reject") {
    const result = await deps.persistence.rejectApplication({
      applicationId,
      actor,
      reason: reason as string,
      at,
    });
    if (result === "conflict") {
      fail(409, "already_decided", "Application was already decided");
    }
  } else if (application.expectedRevision !== undefined) {
    await replaceProjectManifest(
      request,
      deps,
      application.projectId,
      {
        manifest: application.manifest,
        expectedRevision: application.expectedRevision,
        reason: application.changeReason,
      },
      application.id,
    );
  } else {
    // Re-check against the live registry: another approval may have claimed
    // the id or repository since this application was submitted.
    canonicalManifest(application.manifest);
    assertRepositoryUnrestricted(
      application.manifest,
      await deps.persistence.listEnforcements(),
    );
    assertRegistryWith(
      await deps.persistence.listProjects(),
      application.manifest,
      { replaces: false },
    );
    const result = await deps.persistence.approveApplication({
      applicationId,
      actor,
      reason,
      at,
    });
    if (result === "conflict") {
      fail(
        409,
        "registry_conflict",
        "The project id or repository is already listed, or the application was decided",
      );
    }
    await purgeProjectCache(
      deps.cache,
      new URL(request.url).origin,
      application.projectId,
      skillNames(application.manifest),
      await deps.persistence.enforcementGeneration(),
    );
  }
  const updated = await deps.persistence.getApplication(applicationId);
  if (updated === null) fail(500, "internal_error", "Application vanished");
  return json(200, {
    application: publicApplication(updated),
  });
}

async function listAdminProjects(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<Response> {
  const session = await requireAdmin(request, deps);
  const [projects, records] = await Promise.all([
    deps.persistence.listProjects(),
    deps.persistence.listEnforcements(),
  ]);
  const moderation =
    deps.moderatorGithubIds.size === 0
      ? "unconfigured"
      : deps.moderatorGithubIds.has(session.githubId)
        ? "moderator"
        : "not-moderator";
  return json(200, {
    projects: projects.map((project) => ({
      ...adminProject(project),
      enforcement: adminEnforcement(
        project,
        projectRestriction(project.id, records),
        moderation,
      ),
    })),
  });
}

async function replaceProjectManifest(
  request: Request,
  deps: ProjectApiDependencies,
  projectId: string,
  submittedBody?: Record<string, unknown>,
  applicationId?: string,
): Promise<Response> {
  const session = await requireAdmin(request, deps);
  if (!PROJECT_ID.test(projectId)) fail(404, "not_found", "Project not found");
  const body = submittedBody ?? (await readJsonObject(request));
  exactKeys(body, ["manifest", "expectedRevision", "reason"]);
  if (
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1
  ) {
    fail(400, "invalid_request", "Invalid expectedRevision");
  }
  const reason = boundedText(body.reason, "reason", 1, 1000);
  const projects = await deps.persistence.listProjects();
  const current = projects.find((project) => project.id === projectId);
  if (current === undefined) fail(404, "not_found", "Project not found");
  if (current.revision !== body.expectedRevision) {
    fail(409, "stale_revision", "The project changed since you loaded it");
  }
  // Read the generation first: a record that lands after it makes the
  // guarded append below a conflict, so no write uses stale restrictions.
  const enforcementGeneration = await deps.persistence.enforcementGeneration();
  const enforcements = await deps.persistence.listEnforcements();
  const restriction = projectRestriction(projectId, enforcements);
  const { manifest, text } = canonicalManifest(
    await verifiedRewardAsset(
      body.manifest,
      current.manifest.rewardAsset,
      deps,
    ),
  );
  if (manifest.id !== projectId) {
    fail(422, "invalid_manifest", "Project id cannot change");
  }
  // A new revision cannot lift a Quarantine or a Ban (PRD ADM-06).
  if (restriction.state !== "clear" && !enforcedManifest(manifest)) {
    fail(
      409,
      "project_restricted",
      `The project is ${restriction.state}; a revision must keep it paused and retired until reinstatement`,
    );
  }
  // Nor can a revision move a restricted repository, renamed or not, into
  // another project. The project's own restriction is checked above. A
  // project already listed for a restricted repository may still append the
  // paused, retired revision that restriction imposes, if it claims the same
  // repositories as before.
  if (
    !enforcedManifest(manifest) ||
    !sameRepositoryIdentity(current.manifest, manifest)
  )
    assertRepositoryUnrestricted(
      manifest,
      enforcements.filter((record) => record.projectId !== projectId),
    );
  try {
    assertProjectPolicyTransition(current.manifest, manifest);
  } catch (error) {
    invalidManifest(error);
  }
  assertReviewBudgetTransition(current.manifest, manifest, deps.now());
  assertRegistryWith(projects, manifest, { replaces: true });
  // Project skills are generated from this manifest and the reviewed
  // template, so a project goes live only with complete skill content.
  if (manifest.status === "active" && !publishesGeneratedSkills(manifest)) {
    fail(
      422,
      "skill_content_incomplete",
      "Complete the generated-skill contribution fields before activation",
    );
  }
  if (manifest.skill.publishAtRoot) {
    fail(
      422,
      "invalid_manifest",
      "Root skill publication is retired; project skills are served at /projects/<id>/SKILL.md",
    );
  }
  // VET-01: only content a secure-VM scan cleared can become active.
  if (manifest.status === "active") {
    const vetting = await deps.vettingClearance(
      projectId,
      manifest,
      current.revision,
    );
    if (vetting.state !== "cleared")
      fail(
        422,
        "vetting_required",
        `Security vetting is ${vetting.state}. Only a revision whose exact content passed a clean secure-VM scan of the current integration-branch head and skill template can activate; change nothing but the status of the scanned revision.`,
      );
  }
  const result = await deps.persistence.appendProjectRevision(
    {
      projectId,
      applicationId,
      expectedRevision: current.revision,
      manifest,
      manifestText: text,
      manifestSha256: await sha256Hex(new TextEncoder().encode(text)),
      reason,
      actor: { githubId: session.githubId, githubLogin: session.githubLogin },
      at: deps.now().toISOString(),
    },
    enforcementGeneration,
  );
  if (result === "conflict") {
    fail(409, "stale_revision", "The project changed since you loaded it");
  }
  await purgeProjectCache(
    deps.cache,
    new URL(request.url).origin,
    projectId,
    [...new Set([...skillNames(current.manifest), ...skillNames(manifest)])],
    await deps.persistence.enforcementGeneration(),
  );
  const updated = await deps.persistence.getProject(projectId);
  if (updated === null) fail(500, "internal_error", "Project vanished");
  return json(200, {
    project: adminProject(updated),
  });
}

function publicRestriction(
  restriction: ProjectRestriction,
): Record<string, unknown> {
  return {
    projectId: restriction.projectId,
    sourceProjectId: restriction.sourceProjectId,
    state: restriction.state,
    appeal: restriction.appeal,
    since: restriction.since,
  };
}

function activePublicRestrictions(
  projects: ProjectRecord[],
  records: ProjectEnforcement[],
): Record<string, unknown>[] {
  const restricted = activeRestrictions(records);
  // A project listed for a restricted repository is closed with it.
  const shared = projects
    .filter(
      (project) =>
        !restricted.some((restriction) => restriction.projectId === project.id),
    )
    .map((project) => publicRestrictionOf(project, records))
    .filter((restriction) => restriction.state !== "clear");
  return [...restricted, ...shared].map(publicRestriction);
}

/**
 * Refuses an application, approval or revision that claims a repository of
 * a restricted project.
 */
function assertRepositoryUnrestricted(
  manifest: ProjectDefinition,
  enforcements: ProjectEnforcement[],
): void {
  const restriction = restrictionForRepository(manifest, enforcements);
  if (restriction !== null)
    fail(
      403,
      "repository_restricted",
      `This repository belongs to a ${restriction.state} project; only reinstatement can list it again`,
    );
}

function adminEnforcement(
  project: ProjectRecord,
  restriction: ProjectRestriction,
  moderation: ProjectEnforcementState["moderation"],
): ProjectEnforcementState {
  return {
    state: restriction.state,
    appeal: restriction.appeal,
    since: restriction.since,
    restrictedBy: restriction.restrictedBy,
    nextSequence: restriction.nextSequence,
    // The matching revision has not landed while a restricted manifest is
    // still listed or active; public routes stay closed meanwhile.
    revisionPending:
      restriction.state !== "clear" && !enforcedManifest(project.manifest),
    moderation,
    records: restriction.records,
  };
}

async function requireModerator(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<WebSession> {
  const session = await requireAdmin(request, deps);
  if (deps.moderatorGithubIds.size === 0)
    fail(
      403,
      "moderation_unavailable",
      "No project moderator is configured. Set PROJECT_MODERATOR_GITHUB_IDS to enable Quarantine, Ban and reinstatement.",
    );
  if (!deps.moderatorGithubIds.has(session.githubId))
    fail(403, "forbidden", "The project moderator role is required");
  return session;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail(400, "invalid_request", `Invalid ${name}`);
  return value;
}

/** Reason and evidence fields every enforcement request carries. */
function enforcementText(body: Record<string, unknown>): {
  reason: string;
  evidenceReference: string;
} {
  return {
    reason: boundedText(body.reason, "reason", 1, 1000),
    evidenceReference: boundedText(
      body.evidenceReference,
      "evidenceReference",
      1,
      500,
    ),
  };
}

/**
 * Previews or applies one ADM-06 action. The preview and the write run the
 * same plan against the same expected revision and record sequence, so the
 * confirmed write is exactly what the moderator saw, or it fails with 409.
 */
async function enforceProject(
  request: Request,
  deps: ProjectApiDependencies,
  projectId: string,
  mode: "preview" | "apply",
): Promise<Response> {
  const session = await requireModerator(request, deps);
  if (!PROJECT_ID.test(projectId)) fail(404, "not_found", "Project not found");
  const body = await readJsonObject(request);
  exactKeys(body, [
    "action",
    "reason",
    "evidenceReference",
    "expectedRevision",
    "expectedSequence",
  ]);
  if (!ENFORCEMENT_ACTIONS.includes(body.action as EnforcementAction))
    fail(400, "invalid_request", "Invalid enforcement action");
  return await recordEnforcement(deps, {
    projectId,
    action: body.action as EnforcementAction,
    ...enforcementText(body),
    expectedRevision: positiveInteger(
      body.expectedRevision,
      "expectedRevision",
    ),
    expectedSequence: positiveInteger(
      body.expectedSequence,
      "expectedSequence",
    ),
    actor: { githubId: session.githubId, githubLogin: session.githubLogin },
    actorRole: () => "project-moderator",
    decisionSource: "admin-panel",
    mode,
  });
}

/**
 * ELG-02 appeal path: the project steward named in the manifest, or the
 * applicant whose application listed the project, records a reinstatement
 * request. A moderator who did not place the restriction still decides it.
 */
async function requestReinstatement(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<Response> {
  const session = await requireSession(request, deps);
  const body = await readJsonObject(request);
  exactKeys(body, ["projectId", "reason", "evidenceReference"]);
  if (typeof body.projectId !== "string" || !PROJECT_ID.test(body.projectId))
    fail(404, "not_found", "Project not found");
  return await recordEnforcement(deps, {
    projectId: body.projectId,
    action: "request_reinstatement",
    ...enforcementText(body),
    // An appeal changes no revision and has no preview; an open appeal or a
    // concurrent record refuses it with 409.
    expectedRevision: null,
    expectedSequence: null,
    actor: { githubId: session.githubId, githubLogin: session.githubLogin },
    actorRole: async (project) => {
      if (String(project.manifest.steward.github.actorId) === session.githubId)
        return "project-steward";
      const application =
        project.sourceApplicationId === null
          ? null
          : await deps.persistence.getApplication(project.sourceApplicationId);
      if (application?.applicant.githubId === session.githubId)
        return "project-applicant";
      return fail(
        403,
        "forbidden",
        "Only the project steward or the applicant who listed the project can request reinstatement",
      );
    },
    decisionSource: "owner-request",
    mode: "apply",
  });
}

async function recordEnforcement(
  deps: ProjectApiDependencies,
  input: {
    projectId: string;
    action: EnforcementAction;
    reason: string;
    evidenceReference: string;
    /** Null for an owner appeal, which has no preview to confirm. */
    expectedRevision: number | null;
    expectedSequence: number | null;
    actor: GithubActor;
    actorRole: (
      project: ProjectRecord,
    ) => EnforcementActorRole | Promise<EnforcementActorRole>;
    decisionSource: ProjectEnforcement["decisionSource"];
    mode: "preview" | "apply";
  },
): Promise<Response> {
  const {
    projectId,
    action,
    reason,
    evidenceReference,
    expectedRevision,
    expectedSequence,
    actor,
    mode,
  } = input;
  const project = await deps.persistence.getProject(projectId);
  if (project === null) fail(404, "not_found", "Project not found");
  const actorRole = await input.actorRole(project);
  const restriction = projectRestriction(
    projectId,
    await deps.persistence.listEnforcements(),
  );
  if (
    (expectedRevision !== null && project.revision !== expectedRevision) ||
    (expectedSequence !== null && restriction.nextSequence !== expectedSequence)
  )
    fail(409, "stale_enforcement", "The project changed since you loaded it");
  let listedBefore = false;
  if (action === "reinstate" && restriction.openedAtRevision !== null) {
    const opened = await deps.persistence.getRevisionText(
      projectId,
      restriction.openedAtRevision,
    );
    if (opened === null)
      fail(500, "internal_error", "The restricted revision is missing");
    listedBefore =
      (JSON.parse(opened.manifestText) as ProjectDefinition).listingTier !==
      "retired";
  }
  const plan = planEnforcement({
    action,
    actor,
    project,
    restriction,
    listedBefore,
  });
  let vettingReview: ProjectEnforcement["vettingReview"];
  if (action === "reinstate") {
    const vetting = await deps.vettingClearance(
      projectId,
      project.manifest,
      project.revision,
      true,
    );
    const latestRestriction = restriction.records.findLast(
      (record) => record.action === "quarantine" || record.action === "ban",
    );
    if (
      vetting.state !== "cleared" ||
      vetting.assessment.revision !== project.revision ||
      (latestRestriction !== undefined &&
        vetting.assessment.requestedAt < latestRestriction.createdAt)
    )
      fail(
        409,
        "vetting_required",
        "Reinstatement requires a fresh clean scan of the current restricted revision, requested after the latest restriction, at the current integration-branch head and skill template.",
      );
    vettingReview = {
      assessmentId: vetting.assessment.id,
      maliciousAssessmentIds: vetting.reviewedMaliciousAssessmentIds ?? [],
    };
  }
  const recordId = `enf_${deps.randomId().replaceAll("-", "")}`;
  const at = deps.now().toISOString();
  const revisionText =
    plan.manifest === null ? null : JSON.stringify(plan.manifest);
  const revisionSha256 =
    revisionText === null
      ? null
      : await sha256Hex(new TextEncoder().encode(revisionText));
  // A restriction keeps the repository identity it found, so a later rename
  // or application for the same repository stays restricted.
  const identity = repositoryIdentity(project.manifest);
  const record: ProjectEnforcement = {
    id: recordId,
    projectId,
    sequence: restriction.nextSequence,
    action,
    stateAfter: plan.stateAfter,
    appealAfter: plan.appealAfter,
    reason,
    evidenceReference,
    repositoryGithubId: restriction.repositoryGithubId ?? identity.githubId,
    repositoryKeys: [
      ...new Set([...restriction.repositoryKeys, ...identity.keys]),
    ],
    actor,
    actorRole,
    decisionSource: input.decisionSource,
    beforeRevision: project.revision,
    beforeManifestSha256: project.manifestSha256,
    afterRevision: revisionText === null ? null : project.revision + 1,
    afterManifestSha256: revisionSha256,
    result:
      revisionText !== null
        ? "revision_appended"
        : plan.pendingReason !== null
          ? "revision_pending"
          : "no_revision_needed",
    ...(vettingReview ? { vettingReview } : {}),
    createdAt: at,
  };
  const preview: EnforcementPreview = {
    projectId,
    projectName: project.manifest.name,
    action,
    sequence: record.sequence,
    stateBefore: restriction.state,
    stateAfter: record.stateAfter,
    appealBefore: restriction.appeal,
    appealAfter: record.appealAfter,
    result: record.result,
    pendingReason: plan.pendingReason,
    revision: {
      before: project.revision,
      after: record.afterRevision,
      statusBefore: project.manifest.status,
      statusAfter: plan.manifest?.status ?? project.manifest.status,
      listingTierBefore: project.manifest.listingTier,
      listingTierAfter:
        plan.manifest?.listingTier ?? project.manifest.listingTier,
    },
  };
  if (mode === "preview") return json(200, { preview });
  const outcome = await deps.persistence.appendEnforcement(
    record,
    plan.manifest === null || revisionText === null || revisionSha256 === null
      ? null
      : {
          projectId,
          expectedRevision: project.revision,
          manifest: plan.manifest,
          manifestText: revisionText,
          manifestSha256: revisionSha256,
          reason: enforcementRevisionReason(action, recordId),
          actor,
          at,
        },
    // Only a moderator who did not place the restriction may decide it.
    action === "request_reinstatement"
      ? [...deps.moderatorGithubIds].filter(
          (githubId) =>
            !restriction.restrictedBy.some(
              (placed) => placed.githubId === githubId,
            ),
        )
      : [],
  );
  if (outcome === "conflict")
    fail(409, "stale_enforcement", "The project changed since you loaded it");
  // The new record changes the enforcement generation, so every public
  // cache key in every colo is replaced on its next request.
  return json(200, { preview, record });
}

function publicJson(body: Record<string, unknown>): Response {
  const response = json(200, body, PUBLIC_PROJECT_CACHE_CONTROL);
  response.headers.set("access-control-allow-origin", "*");
  return response;
}

async function listPublicProjects(
  deps: ProjectApiDependencies,
): Promise<Response> {
  const [projects, records] = await Promise.all([
    deps.persistence.listProjects(),
    deps.persistence.listEnforcements(),
  ]);
  return publicJson({
    schemaVersion: "1",
    projects: projects.map((project) => project.manifest),
    // Restricted projects stay in the list for history; every reader must
    // treat them as paused and retired, even before the revision lands.
    restrictions: activePublicRestrictions(projects, records),
  });
}

async function readPublicProject(
  deps: ProjectApiDependencies,
  projectId: string,
): Promise<Response> {
  if (!PROJECT_ID.test(projectId)) fail(404, "not_found", "Project not found");
  const project = await deps.persistence.getProject(projectId);
  if (project === null) fail(404, "not_found", "Project not found");
  const restriction = publicRestrictionOf(
    project,
    await deps.persistence.listEnforcements(),
  );
  if (restriction.state !== "clear") {
    // An appeal names the project whose records hold the restriction.
    const appeal =
      restriction.sourceProjectId === project.id
        ? "The project steward or applicant may request reinstatement"
        : `The restriction is recorded on project ${restriction.sourceProjectId}, which claims the same repository; its steward or applicant may request reinstatement of ${restriction.sourceProjectId}`;
    return json(410, {
      error: "project_restricted",
      message: `This project is ${restriction.state}. Its history stays public; its skills and participation are closed. ${appeal} with POST /api/v1/project-appeals.`,
      restriction: publicRestriction(restriction),
    });
  }
  if (project.manifest.listingTier === "retired")
    fail(404, "not_found", "Project not found");
  const vetting = await deps.vettingClearance(
    project.id,
    project.manifest,
    project.revision,
  );
  const response = json(200, {
    schemaVersion: "1",
    project: project.manifest,
    revision: project.revision,
    manifestSha256: project.manifestSha256,
    updatedAt: project.updatedAt,
    skillsPublished:
      publishesGeneratedSkills(project.manifest) && vetting.state === "cleared",
    vetting,
  });
  response.headers.set("access-control-allow-origin", "*");
  return response;
}

/**
 * One approved revision with its exact stored bytes. A generated skill's
 * installer hashes these bytes against the digest bound in its provenance.
 */
async function getPublicRevision(
  deps: ProjectApiDependencies,
  projectId: string,
  revisionText: string,
): Promise<Response> {
  const revision = Number(revisionText);
  if (
    !PROJECT_ID.test(projectId) ||
    !/^[1-9][0-9]{0,8}$/u.test(revisionText) ||
    !Number.isSafeInteger(revision)
  )
    fail(404, "not_found", "Revision not found");
  const stored = await deps.persistence.getRevisionText(projectId, revision);
  if (stored === null) fail(404, "not_found", "Revision not found");
  return json(
    200,
    {
      schemaVersion: "1",
      projectId,
      revision,
      manifestSha256: stored.manifestSha256,
      manifestText: stored.manifestText,
    },
    "public, max-age=31536000, immutable",
  );
}

async function listPublicRevisions(
  deps: ProjectApiDependencies,
): Promise<Response> {
  const revisions = await deps.persistence.listRevisions();
  return publicJson({ schemaVersion: "1", revisions });
}

const GITHUB_LOOKUP_CACHE_CONTROL = "private, max-age=300";

async function githubLookup(
  request: Request,
  deps: ProjectApiDependencies,
  parts: string[],
): Promise<Response> {
  const session = await requireSession(request, deps);
  // Public GitHub facts are the same for every caller, so the edge cache is
  // shared; the session only gates who may spend the lookup budget.
  const url = new URL(request.url);
  const cacheRequest = new Request(
    parts[1] === "owned-repositories"
      ? `${url.origin}/api/v1/project-github/owned-repositories/${session.githubLogin.toLowerCase()}`
      : `${url.origin}${url.pathname.toLowerCase()}`,
  );
  const build = async () => {
    try {
      if (parts[1] === "owned-repositories") {
        if (!validGithubLogin(session.githubLogin))
          fail(
            400,
            "invalid_request",
            "The signed-in GitHub login is not valid.",
          );
        const repositories = await listOwnedRepositories(
          deps.github.fetch,
          deps.github.token,
          session.githubLogin,
          deps.github.apiOrigin,
        );
        return json(200, { repositories }, "public, max-age=0, s-maxage=300");
      }
      const repository = `${parts[2]}/${parts[3]}`;
      if (!validRepositoryPath(repository))
        fail(400, "invalid_request", "Enter the repository as owner/name.");
      const facts = await lookupGitHubRepository(
        deps.github.fetch,
        deps.github.token,
        repository,
        deps.github.apiOrigin,
      );
      return json(
        200,
        { repository: facts },
        "public, max-age=0, s-maxage=300",
      );
    } catch (error) {
      if (error instanceof GithubLookupError)
        fail(error.status, error.code, error.message);
      throw error;
    }
  };
  const response = await cachedPublicResponse(
    deps.cache,
    cacheRequest,
    build,
    deps.waitUntil,
  );
  response.headers.set("cache-control", GITHUB_LOOKUP_CACHE_CONTROL);
  return response;
}

function isProjectRoute(parts: string[]): boolean {
  return (
    // Deeper /projects/:id/... paths belong to the trace API.
    (parts[0] === "projects" && parts.length <= 2) ||
    parts[0] === "project-github" ||
    parts[0] === "project-revisions" ||
    parts[0] === "project-session" ||
    parts[0] === "project-applications" ||
    parts[0] === "project-appeals" ||
    (parts[0] === "admin" &&
      (parts[1] === "projects" || parts[1] === "project-applications"))
  );
}

/** Returns null when the path belongs to another API module. */
export async function handleProjectApi(
  request: Request,
  deps: ProjectApiDependencies,
): Promise<Response | null> {
  const parts = pathParts(request);
  const route = `${request.method} ${parts
    .map((part, index) =>
      (parts[0] === "admin" && index === 2) ||
      (parts[0] === "projects" && index === 1)
        ? ":id"
        : parts[0] === "project-github" &&
            parts[1] === "repositories" &&
            index >= 2
          ? ":name"
          : part,
    )
    .join("/")}`;
  try {
    // Writes ride the SameSite session cookie, so they must come from this
    // origin as JSON; a cross-site form can never submit one.
    if (
      request.method !== "GET" &&
      parts.length > 0 &&
      isProjectRoute(parts) &&
      (request.headers.get("origin") !== new URL(request.url).origin ||
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json")
    ) {
      fail(403, "origin_forbidden", "Requests must come from this site");
    }
    if (
      request.method === "GET" &&
      parts[0] === "project-revisions" &&
      parts.length === 3
    )
      return await getPublicRevision(deps, parts[1], parts[2]);
    switch (route) {
      case "GET projects":
        return await cachedPublicResponse(
          deps.cache,
          request,
          () => listPublicProjects(deps),
          deps.waitUntil,
          await deps.persistence.enforcementGeneration(),
        );
      case "GET project-revisions":
        return await cachedPublicResponse(
          deps.cache,
          request,
          () => listPublicRevisions(deps),
          deps.waitUntil,
          await deps.persistence.enforcementGeneration(),
        );
      case "GET projects/:id":
        return await readPublicProject(deps, parts[1]);
      case "GET project-github/owned-repositories":
      case "GET project-github/repositories/:name/:name":
        return await githubLookup(request, deps, parts);
      case "GET project-session": {
        // Signed out is an ordinary state, not an error the browser logs.
        const actor = await deps.sessionActor(request);
        return json(200, {
          session: actor === null ? null : sessionBody(actor, deps),
        });
      }
      case "POST project-applications":
        return await submitApplication(request, deps);
      case "GET project-applications/mine":
        return await listMyApplications(request, deps);
      case "GET admin/project-applications":
        return await listAdminApplications(request, deps);
      case "POST admin/project-applications/:id/approve":
        return await decideApplication(request, deps, parts[2], "approve");
      case "POST admin/project-applications/:id/reject":
        return await decideApplication(request, deps, parts[2], "reject");
      case "GET admin/projects":
        return await listAdminProjects(request, deps);
      case "PUT admin/projects/:id/manifest":
        return await replaceProjectManifest(request, deps, parts[2]);
      case "POST admin/projects/:id/enforcement-preview":
        return await enforceProject(request, deps, parts[2], "preview");
      case "POST admin/projects/:id/enforcement":
        return await enforceProject(request, deps, parts[2], "apply");
      case "POST project-appeals":
        return await requestReinstatement(request, deps);
    }
    if (isProjectRoute(parts)) return json(404, { error: "not_found" });
    return null;
  } catch (caught) {
    const error =
      typeof caught === "object" && caught !== null
        ? (caught as Partial<ApiError>)
        : {};
    const status =
      Number.isSafeInteger(error.status) &&
      Number(error.status) >= 400 &&
      Number(error.status) <= 599
        ? Number(error.status)
        : 500;
    if (status >= 500) console.error("project API failure");
    return json(status, {
      error:
        typeof error.code === "string" &&
        /^[a-z][a-z0-9_]{1,63}$/u.test(error.code)
          ? error.code
          : "internal_error",
      message:
        status >= 500 || typeof error.message !== "string"
          ? "Internal error"
          : error.message,
    });
  }
}
