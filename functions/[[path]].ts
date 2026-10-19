import {
  CloudflareProjectPersistence,
  type ProjectD1Database,
} from "../backend/projects/cloudflare-persistence";
import { edgeCache } from "../backend/projects/edge-cache";
import {
  handleProjectArtifactRequest,
  type SkillTemplateIndex,
  type SkillTemplateSource,
} from "../backend/projects/skill-publication";
import { CloudflareVettingPersistence } from "../backend/vetting/persistence";
import { onRequest as socialMetadata } from "./index";

type Env = {
  SLOP_DB?: ProjectD1Database;
  ASSETS?: { fetch(request: Request): Promise<Response> };
};

type PagesContext = {
  request: Request;
  env: Env;
  next(): Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
};

const MAX_TEMPLATE_FILE_BYTES = 1024 * 1024;

/** Reads the build's published template bytes through the static assets. */
function templateSource(
  context: PagesContext,
): () => Promise<SkillTemplateSource> {
  return async () => {
    const assets = context.env.ASSETS;
    if (!assets) throw new Error("Static assets are unavailable");
    const origin = new URL(context.request.url).origin;
    const read = async (path: string) => {
      const response = await assets.fetch(
        new Request(`${origin}/skill-templates/${path}`),
      );
      if (!response.ok) throw new Error(`Skill template ${path} is missing`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_TEMPLATE_FILE_BYTES)
        throw new Error(`Skill template ${path} is too large`);
      return bytes;
    };
    const index = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await read("index.json"),
      ),
    ) as SkillTemplateIndex;
    return { index, readFile: read };
  };
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const db = context.env.SLOP_DB;
  if (db !== undefined) {
    const persistence = new CloudflareProjectPersistence(db);
    const vetting = new CloudflareVettingPersistence(db);
    const artifact = await handleProjectArtifactRequest(context.request, {
      getProject: (id) => persistence.getProject(id),
      listProjects: () => persistence.listProjects(),
      listEnforcements: () => persistence.listEnforcements(),
      enforcementGeneration: () => persistence.enforcementGeneration(),
      loadTemplate: templateSource(context),
      vettingCleared: async (project) =>
        (
          await vetting.manifestClearance(
            project.id,
            project.manifest,
            project.revision,
          )
        ).state === "cleared",
      cache: edgeCache(),
      waitUntil: context.waitUntil?.bind(context),
    });
    if (artifact !== null) return artifact;
  }
  return socialMetadata(context);
}
