/**
 * Serves each project's generated skills, reviewer skill, references,
 * archive, routing manifests, terms, and the project discovery index from
 * the current D1 revision and the one reviewed template pair. Nothing here
 * reads GitHub or a chain; responses are edge cached and purged on writes.
 */

import {
  CONTRIBUTOR_TEMPLATE_PATH,
  projectPublishesSkills,
  type RenderedSkill,
  renderProjectSkills,
  type SkillTemplateIndex,
  skillManifest,
} from "../../src/lib/project-skill-render.mjs";
import type { ProjectRecord } from "./contracts";
import {
  cachedPublicResponse,
  type EdgeCache,
  PUBLIC_PROJECT_CACHE_CONTROL,
} from "./edge-cache";

export type SkillTemplateSource = {
  index: SkillTemplateIndex;
  readFile(path: string): Promise<Uint8Array>;
};

export type SkillPublicationDependencies = {
  getProject(id: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  loadTemplate(): Promise<SkillTemplateSource>;
  /** The origin written into generated skills and manifests. */
  publicOrigin: string;
  cache?: EdgeCache;
  waitUntil?: (promise: Promise<unknown>) => void;
};

const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;

type Artifact =
  | "terms"
  | "skill"
  | "reference"
  | "review-skill"
  | "skill-manifest"
  | "review-skill-manifest"
  | "archive"
  | "checksum";

function route(
  pathname: string,
):
  | { projectId: string; artifact: Artifact; file?: string }
  | "discovery"
  | null {
  if (pathname === "/.well-known/slop/projects.json") return "discovery";
  const parts = pathname.split("/");
  if (
    parts[0] !== "" ||
    parts[1] !== "projects" ||
    !PROJECT_ID.test(parts[2] ?? "")
  )
    return null;
  const projectId = parts[2];
  const rest = parts.slice(3).join("/");
  const artifacts: Record<string, Artifact> = {
    "terms.json": "terms",
    "SKILL.md": "skill",
    "skill.md": "skill",
    "references/project.md": "reference",
    "review/SKILL.md": "review-skill",
    "review-skill.md": "review-skill",
    "skill-manifest.json": "skill-manifest",
    "review-skill-manifest.json": "review-skill-manifest",
  };
  if (Object.hasOwn(artifacts, rest))
    return { projectId, artifact: artifacts[rest] };
  const download = /^downloads\/([a-z0-9-]{1,96})\.skill(\.sha256)?$/u.exec(
    rest,
  );
  if (download)
    return {
      projectId,
      artifact: download[2] ? "checksum" : "archive",
      file: download[1],
    };
  return null;
}

function headers(contentType: string, extra: Record<string, string> = {}) {
  return {
    "access-control-allow-origin": "*",
    "cache-control": PUBLIC_PROJECT_CACHE_CONTROL,
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": contentType,
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

function jsonBody(value: unknown): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status: 200,
    headers: headers("application/json; charset=utf-8"),
  });
}

function body(bytes: Uint8Array): BodyInit {
  return bytes as Uint8Array<ArrayBuffer>;
}

function markdown(bytes: Uint8Array): Response {
  return new Response(body(bytes), {
    status: 200,
    headers: headers("text/markdown; charset=utf-8"),
  });
}

function listed(project: ProjectRecord | null): project is ProjectRecord {
  return project !== null && project.manifest.listingTier !== "retired";
}

async function render(
  project: ProjectRecord,
  deps: SkillPublicationDependencies,
): Promise<{ contributor: RenderedSkill; reviewer: RenderedSkill }> {
  const template = await deps.loadTemplate();
  return renderProjectSkills({
    template: template.index,
    readFile: template.readFile,
    manifest: project.manifest,
    revision: project.revision,
    manifestSha256: project.manifestSha256,
    publicOrigin: deps.publicOrigin,
  });
}

async function discovery(
  deps: SkillPublicationDependencies,
): Promise<Response> {
  const projects = (await deps.listProjects()).filter(
    (project) => listed(project) && projectPublishesSkills(project.manifest),
  );
  return jsonBody({
    schemaVersion: "2",
    skillTemplate: CONTRIBUTOR_TEMPLATE_PATH,
    projects: projects.flatMap((project) =>
      project.manifest.repositories.map((repository) => {
        const base = `${deps.publicOrigin}/projects/${project.id}`;
        return {
          project_id: project.id,
          project_url: `${base}/`,
          project_revision: project.revision,
          manifest_sha256: project.manifestSha256,
          repository: repository.aliases?.at(-1) ?? repository.id,
          skill: project.manifest.skill.id,
          skill_url: `${base}/SKILL.md`,
          skill_manifest: `${base}/skill-manifest.json`,
          review_skill: project.manifest.reviewSkill.id,
          review_skill_manifest: `${base}/review-skill-manifest.json`,
        };
      }),
    ),
  });
}

async function artifact(
  target: { projectId: string; artifact: Artifact; file?: string },
  deps: SkillPublicationDependencies,
): Promise<Response> {
  const project = await deps.getProject(target.projectId);
  if (!listed(project)) return text(404, "Project not found.\n");
  if (target.artifact === "terms") {
    const manifest = project.manifest;
    return jsonBody({
      schemaVersion: "1",
      projectId: manifest.id,
      projectRevision: project.revision,
      manifestSha256: project.manifestSha256,
      status: manifest.status,
      steward: manifest.steward,
      authority: manifest.authority,
      terms: manifest.terms,
    });
  }
  if (!projectPublishesSkills(project.manifest))
    return text(
      404,
      "This project has not published its skills yet. Its maintainers must complete the skill content first.\n",
    );
  const rendered = await render(project, deps);
  switch (target.artifact) {
    case "skill":
      return markdown(rendered.contributor.skillMarkdown);
    case "reference": {
      const file = rendered.contributor.files.find(
        (entry) => entry.path === "references/project.md",
      );
      return file ? markdown(file.bytes) : text(404, "Reference not found.\n");
    }
    case "review-skill":
      return markdown(rendered.reviewer.skillMarkdown);
    case "skill-manifest":
    case "review-skill-manifest": {
      const review = target.artifact === "review-skill-manifest";
      return jsonBody(
        skillManifest(review ? rendered.reviewer : rendered.contributor, {
          publicOrigin: deps.publicOrigin,
          projectId: project.id,
          review,
        }),
      );
    }
    case "archive":
    case "checksum": {
      const skill = [rendered.contributor, rendered.reviewer].find(
        (candidate) => candidate.name === target.file,
      );
      if (!skill) return text(404, "Archive not found.\n");
      if (target.artifact === "checksum")
        return new Response(`${skill.archiveSha256}  ${skill.name}.skill\n`, {
          status: 200,
          headers: headers("text/plain; charset=utf-8"),
        });
      return new Response(body(skill.archive), {
        status: 200,
        headers: headers("application/octet-stream", {
          "content-disposition": `attachment; filename="${skill.name}.skill"`,
        }),
      });
    }
  }
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
    );
  } catch {
    console.error("project artifact failure");
    return text(503, "Project artifacts are unavailable. Try again.\n");
  }
}
