/**
 * Loads the current project registry for the browser. The site never reads
 * GitHub or a chain per page view; this is one cached D1 read.
 */

import { fetchWithDeadline, readBoundedJson } from "./browser-json";

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

/** The registry source; the browser-test fixture build points at a file. */
export const PROJECT_REGISTRY_URL: string =
  import.meta.env.VITE_SLOP_PROJECT_REGISTRY_URL || "/api/v1/projects";

declare global {
  var __SLOP_PROJECT_REGISTRY__: unknown[] | undefined;
  var __SLOP_PROJECT_REGISTRY_ERROR__: string | undefined;
}

export async function loadProjectRegistry(): Promise<unknown[]> {
  const response = await fetchWithDeadline(PROJECT_REGISTRY_URL, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`The project registry returned HTTP ${response.status}.`);
  const value = await readBoundedJson(
    response,
    MAX_REGISTRY_BYTES,
    "The project registry",
  );
  const body = value as {
    schemaVersion?: unknown;
    projects?: unknown;
    restrictions?: unknown;
  } | null;
  const projects = body?.projects;
  // An API that predates enforcement (PRD ADM-06) sends no restrictions.
  const restrictions = body?.restrictions ?? [];
  if (
    body?.schemaVersion !== "1" ||
    !Array.isArray(projects) ||
    !Array.isArray(restrictions)
  )
    throw new Error("The project registry returned an unexpected response.");
  const restricted = new Set(
    restrictions.map((entry) => {
      const projectId = (entry as { projectId?: unknown } | null)?.projectId;
      if (typeof projectId !== "string")
        throw new Error(
          "The project registry returned an unexpected restriction.",
        );
      return projectId;
    }),
  );
  // A quarantined or banned project is shown as paused and retired at once,
  // even while its matching revision is still pending.
  return projects.map((project) =>
    restricted.has((project as { id?: unknown } | null)?.id as string)
      ? { ...(project as object), status: "paused", listingTier: "retired" }
      : project,
  );
}

export function installProjectRegistry(projects: unknown[]): void {
  globalThis.__SLOP_PROJECT_REGISTRY__ = projects;
}
