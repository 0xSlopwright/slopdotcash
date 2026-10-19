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
  const projects = (value as { schemaVersion?: unknown; projects?: unknown })
    ?.projects;
  if (
    (value as { schemaVersion?: unknown })?.schemaVersion !== "1" ||
    !Array.isArray(projects)
  )
    throw new Error("The project registry returned an unexpected response.");
  return projects;
}

export function installProjectRegistry(projects: unknown[]): void {
  globalThis.__SLOP_PROJECT_REGISTRY__ = projects;
}
