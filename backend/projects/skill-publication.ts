/**
 * Serves each project's generated skills, guides, routing manifests,
 * archives, terms, and the project discovery index from the current D1
 * revision and the canonical templates. Nothing here reads GitHub or a
 * chain; responses are edge cached and purged on admin writes.
 */

import { publishesGeneratedSkills } from "../../src/lib/project-skill.mjs";
import {
  buildProjectPublication,
  PUBLIC_SITE_ORIGIN,
} from "../../src/lib/project-skill-publication.mjs";
import type { ProjectEnforcement, ProjectRecord } from "./contracts";
import {
  cachedPublicResponse,
  type EdgeCache,
  PUBLIC_PROJECT_CACHE_CONTROL,
} from "./edge-cache";
import { projectRestriction } from "./enforcement";

/** The build's /skill-templates/index.json. */
export type SkillTemplateIndex = {
  schemaVersion: "1";
  repository: string;
  commit: string;
  revisionStatus: "committed" | "working-tree";
  contributor: {
    sourcePath: string;
    files: { path: string; sha256: string }[];
  };
  reviewer: {
    sourcePath: string;
    files: { path: string; sha256: string }[];
  };
  renderer: { paths: string[]; revisionStatus: "committed" | "working-tree" };
  acceptedRevisions: string[];
};

export type SkillTemplateSource = {
  index: SkillTemplateIndex;
  readFile(path: string): Promise<Uint8Array>;
};

export type SkillPublicationDependencies = {
  getProject(id: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  listEnforcements(): Promise<ProjectEnforcement[]>;
  enforcementGeneration(): Promise<number>;
  loadTemplate(): Promise<SkillTemplateSource>;
  /** True only when the revision's exact content passed security vetting (VET-01). */
  vettingCleared(project: ProjectRecord): Promise<boolean>;
  cache?: EdgeCache;
  waitUntil?: (promise: Promise<unknown>) => void;
};

const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;
/** Paths the generated publication defines, plus readable aliases. */
const ARTIFACT =
  /^(?:(?:review-)?(?:skill|mission|codex|claude|claude-code|manual)\.md|(?:review-)?skill-manifest\.json|downloads\/[a-z0-9-]{1,96}\.skill(?:\.sha256)?|terms\.json|SKILL\.md|review\/SKILL\.md)$/u;
const ALIASES: Record<string, string> = {
  "SKILL.md": "skill.md",
  "review/SKILL.md": "review-skill.md",
};

function route(
  pathname: string,
): { projectId: string; path: string } | "discovery" | null {
  if (pathname === "/.well-known/slop/projects.json") return "discovery";
  const match = /^\/projects\/([^/]+)\/(.+)$/u.exec(pathname);
  if (!match || !PROJECT_ID.test(match[1]) || !ARTIFACT.test(match[2]))
    return null;
  return { projectId: match[1], path: ALIASES[match[2]] ?? match[2] };
}

function contentType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".sha256")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function headers(type: string, extra: Record<string, string> = {}) {
  return {
    "access-control-allow-origin": "*",
    "cache-control": PUBLIC_PROJECT_CACHE_CONTROL,
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": type,
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      ...headers("text/plain; charset=utf-8"),
      "cache-control": "no-store",
    },
  });
}

function bytesResponse(path: string, bytes: Uint8Array): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: headers(
      contentType(path),
      path.startsWith("downloads/") && path.endsWith(".skill")
        ? { "content-disposition": "attachment" }
        : {},
    ),
  });
}

function jsonResponse(value: unknown): Response {
  return bytesResponse(
    "value.json",
    new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
  );
}

/** A retired or restricted project serves no skill, guide or archive. */
function listed(
  project: ProjectRecord | null,
  records: ProjectEnforcement[],
): project is ProjectRecord {
  return (
    project !== null &&
    project.manifest.listingTier !== "retired" &&
    projectRestriction(project.id, records).state === "clear"
  );
}

/** The routing index the bootstrap skill matches a repository origin against. */
async function discovery(
  deps: SkillPublicationDependencies,
): Promise<Response> {
  const [all, records] = await Promise.all([
    deps.listProjects(),
    deps.listEnforcements(),
  ]);
  const projects: ProjectRecord[] = [];
  for (const project of all)
    if (
      listed(project, records) &&
      publishesGeneratedSkills(project.manifest) &&
      (await deps.vettingCleared(project))
    )
      projects.push(project);
  return jsonResponse({
    schemaVersion: "1",
    projects: projects.flatMap((project) =>
      project.manifest.repositories.map((repository) => ({
        project_id: project.id,
        project_url: `${PUBLIC_SITE_ORIGIN}/projects/${project.id}/`,
        repository: repository.aliases?.at(-1) ?? repository.id,
        review_skill: project.manifest.reviewSkill.id,
        review_skill_manifest: `${PUBLIC_SITE_ORIGIN}/projects/${project.id}/review-skill-manifest.json`,
        skill: project.manifest.skill.id,
        skill_source: project.manifest.skill.sourcePath,
      })),
    ),
  });
}

async function artifact(
  target: { projectId: string; path: string },
  deps: SkillPublicationDependencies,
): Promise<Response> {
  const [project, records] = await Promise.all([
    deps.getProject(target.projectId),
    deps.listEnforcements(),
  ]);
  const restriction = projectRestriction(target.projectId, records);
  if (project !== null && restriction.state !== "clear")
    return text(
      410,
      `This project is ${restriction.state}. Its skills, guides and archives are not available.\n`,
    );
  if (!listed(project, records)) return text(404, "Project not found.\n");
  if (target.path === "terms.json") {
    const manifest = project.manifest;
    return jsonResponse({
      schemaVersion: "1",
      projectId: manifest.id,
      status: manifest.status,
      steward: manifest.steward,
      authority: manifest.authority,
      terms: manifest.terms,
      // Public program terms only; cases never leave the restricted tables.
      securityBounty: manifest.securityBounty ?? null,
    });
  }
  if (!publishesGeneratedSkills(project.manifest))
    return text(
      404,
      "This project has not published its skills yet. Its maintainers must complete the contribution fields first.\n",
    );
  if (!(await deps.vettingCleared(project)))
    return text(
      404,
      "This project revision has not passed security vetting. Slop serves no skill for an unscanned, queued, quarantined or banned revision.\n",
    );
  const template = await deps.loadTemplate();
  const files = await buildProjectPublication({
    template: template.index,
    readFile: template.readFile,
    project: project.manifest,
    revision: project.revision,
    manifestSha256: project.manifestSha256,
    generatedAt: project.updatedAt,
  });
  const bytes = files?.[target.path];
  return bytes === undefined
    ? text(404, "Artifact not found.\n")
    : bytesResponse(target.path, bytes);
}

/** Returns null when the path is not a project artifact, so the SPA serves it. */
export async function handleProjectArtifactRequest(
  request: Request,
  deps: SkillPublicationDependencies,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const target = route(new URL(request.url).pathname);
  if (target === null) return null;
  try {
    return await cachedPublicResponse(
      deps.cache,
      request,
      () => (target === "discovery" ? discovery(deps) : artifact(target, deps)),
      deps.waitUntil,
      await deps.enforcementGeneration(),
    );
  } catch {
    console.error("project artifact failure");
    return text(503, "Project artifacts are unavailable. Try again.\n");
  }
}
