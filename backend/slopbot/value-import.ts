import { readBoundedJson } from "../../src/lib/browser-json";

/** This binding targets a named Worker RPC entrypoint, never a public URL. */
export interface HistoricalValueBinding {
  publishSubscription(input: unknown): Promise<{
    recordDigest: string;
    sequence: number;
  }>;
}

export async function handleHistoricalValueImport(
  request: Request,
  deps: {
    adminGithubIds: ReadonlySet<string>;
    sessionActor: (request: Request) => Promise<{ githubId: string } | null>;
    publisher?: HistoricalValueBinding;
  },
): Promise<Response> {
  const respond = (status: number, body: unknown) =>
    Response.json(body, {
      status,
      headers: { "cache-control": "private, no-store" },
    });
  if (request.method !== "POST")
    return respond(405, { error: "method_not_allowed" });
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("content-type")?.split(";")[0] !== "application/json"
  )
    return respond(403, { error: "origin_forbidden" });
  try {
    const actor = await deps.sessionActor(request);
    if (!actor) return respond(401, { error: "unauthorized" });
    if (!deps.adminGithubIds.has(actor.githubId))
      return respond(403, { error: "forbidden" });
    if (!deps.publisher) return respond(503, { error: "intake_unavailable" });
    let input: unknown;
    try {
      input = await readBoundedJson(
        request as unknown as Response,
        25 * 1024 * 1024,
        "historical assessment",
      );
    } catch {
      return respond(400, { error: "invalid_request" });
    }
    const receipt = await deps.publisher.publishSubscription(input);
    return respond(200, receipt);
  } catch {
    // Do not echo source bodies, provider declarations or upstream errors.
    return respond(409, { error: "assessment_not_published" });
  }
}
