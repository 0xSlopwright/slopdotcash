/**
 * Browser client for the slop.cash project registry API. Requests ride the
 * site sign-in cookie from /login; the API decides authority on every call.
 */

import { useEffect, useState } from "react";
import { fetchWithDeadline } from "./browser-json";
import type {
  PublicProjectApplication as ProjectApplication,
  WebSession as ProjectSession,
} from "./project-contracts";
import type { ProjectDefinition } from "./projects.mjs";

export type {
  AdminProject,
  EnforcementAction,
  EnforcementPreview,
  ProjectEnforcement as ProjectEnforcementRecord,
  ProjectEnforcementState,
  PublicProjectApplication as ProjectApplication,
  WebSession as ProjectSession,
} from "./project-contracts";

export class ProjectApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function projectApiRequest<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithDeadline(`/api/v1/${path}`, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ProjectApiError(
      0,
      "network_error",
      error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
        ? "The request timed out. Try again."
        : "The network request failed. Try again.",
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    )
      throw new ProjectApiError(
        0,
        "network_error",
        "The request timed out. Try again.",
      );
    throw new ProjectApiError(
      response.status,
      "invalid_response",
      "The server returned an unreadable response.",
    );
  }
  if (!response.ok) {
    const error = parsed as { error?: unknown; message?: unknown };
    throw new ProjectApiError(
      response.status,
      typeof error.error === "string" ? error.error : "request_failed",
      typeof error.message === "string"
        ? error.message
        : `The request failed with HTTP ${response.status}.`,
    );
  }
  return parsed as T;
}

/** Resolves null when the visitor is not signed in. */
export async function currentProjectSession(): Promise<ProjectSession | null> {
  return (
    await projectApiRequest<{ session: ProjectSession | null }>(
      "GET",
      "project-session",
    )
  ).session;
}

export function submitProjectApplication(
  manifest: ProjectDefinition,
): Promise<{ application: ProjectApplication }> {
  return projectApiRequest("POST", "project-applications", { manifest });
}

export type ProjectSessionState =
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "signed-in"; session: ProjectSession };

/** Reads the site sign-in session once per mount. */
export function useProjectSession(): ProjectSessionState {
  const [state, setState] = useState<ProjectSessionState>({
    status: "checking",
  });
  useEffect(() => {
    let active = true;
    currentProjectSession().then(
      (session) => {
        if (!active) return;
        setState(
          session === null
            ? { status: "signed-out" }
            : { status: "signed-in", session },
        );
      },
      (error: unknown) => {
        if (active)
          setState({
            status: "error",
            message:
              error instanceof Error ? error.message : "Something went wrong.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}
