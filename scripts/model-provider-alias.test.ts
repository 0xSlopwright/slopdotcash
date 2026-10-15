import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test.each([
  ["constructor", "example-v1", "constructor", "example-v1"],
  ["Constructor", "example-v1", "constructor", "example-v1"],
  ["OpenAI-Codex", "openai/gpt-5.6", "openai", "gpt-5.6"],
  ["z.ai", "z-ai/glm-5", "zai", "glm-5"],
  ["independent", "independent/example-v1", "independent", "example-v1"],
])(
  "preserves the accepted %s provider in model outcomes",
  (provider, model, expectedProvider, expectedModel) => {
    const program = `
import { assessModelAttribution } from "./src/lib/leaderboard";
import { summarizeModelOutcomes } from "./src/lib/model-outcomes";
const marker = {
  provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(model)},
  client: "codex",
  skill_revision: "N/A - ordinary contribution without optional run evidence",
};
const result = assessModelAttribution([
  {
    id: "PR_test", artifactId: "PR_test", kind: "body",
    body: [
      "Made via @slopdotcash",
      "AI provider/model: " + marker.provider + " / " + marker.model,
      "Client / agent tooling: codex",
      "Contribution skill revision: " + marker.skill_revision,
      "Attribution status: self-reported",
      "— [contributor]",
      "<!-- slop-contribution-attribution:v1 " + JSON.stringify(marker) + " -->",
    ].join("\\n"),
    url: "https://example.test/pull/1",
    createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
    author: {
      id: "U_test", login: "contributor", avatarUrl: "",
      url: "https://example.test/contributor", kind: "User",
    },
  },
], { requireEverySource: true });
console.log(JSON.stringify({
  coverage: result.coverage.status, invalidMarkers: result.invalidMarkers,
  summary: summarizeModelOutcomes({ attributions: result.declarations, ledger: [] }),
}));`;
    const run = spawnSync(process.execPath, ["--eval", program], {
      cwd: resolve(import.meta.dir, ".."),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.coverage).toBe("complete");
    expect(result.invalidMarkers).toEqual([]);
    expect(result.summary.models).toHaveLength(1);
    expect(result.summary.models[0]).toMatchObject({
      key: `${expectedProvider}/${expectedModel}`,
      provider: expectedProvider,
      model: expectedModel,
      declarations: 1,
      contributors: 1,
    });
  },
);
