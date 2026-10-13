import { expect, test } from "bun:test";
import { assessModelAttribution } from "../src/lib/leaderboard";
import type { GitHubTextSource } from "../src/lib/leaderboard-types";

test("accepts the ordinary Slop disclose marker as a v1 declaration", () => {
  const footer = `Made via @slopdotcash
AI provider/model: OpenAI / gpt-5
Client / agent tooling: codex
Contribution skill revision: N/A - ordinary GitHub contribution without optional run evidence
Attribution status: self-reported
— [contributor]
<!-- slop-contribution-attribution:v1 {"provider":"OpenAI","model":"gpt-5","client":"codex","skill_revision":"N/A - ordinary GitHub contribution without optional run evidence"} -->`;
  const result = assessModelAttribution(
    [
      {
        id: "PR_test",
        artifactId: "PR_test",
        kind: "body",
        body: footer,
        url: "https://example.test/pull/1",
        createdAt: "2026-10-13T00:00:00Z",
        updatedAt: "2026-10-13T00:00:00Z",
        author: {
          id: "U_test",
          login: "contributor",
          avatarUrl: "",
          url: "https://example.test/contributor",
          kind: "User",
        },
      } satisfies GitHubTextSource,
    ],
    { requireEverySource: true },
  );

  expect(result.coverage.status).toBe("complete");
  expect(result.invalidMarkers).toEqual([]);
});
