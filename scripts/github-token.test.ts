import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./github-token.ts", import.meta.url));

test.each([
  ["GH_TOKEN only", "", " test-only-gh-token ", "test-only-gh-token"],
  [
    "GITHUB_TOKEN first",
    " test-only-github-token ",
    "other",
    "test-only-github-token",
  ],
  ["blank GITHUB_TOKEN", "  ", "test-only-gh-token", "test-only-gh-token"],
])(
  "GitHub ingestion can authenticate without gh: %s",
  (_name, github, gh, expected) => {
    const result = spawnSync(
      process.execPath,
      [
        "--no-env-file",
        "--eval",
        `const { resolveGitHubToken } = await import(${JSON.stringify(source)}); console.log(await resolveGitHubToken());`,
      ],
      {
        encoding: "utf8",
        env: { PATH: "/no-github-cli", GITHUB_TOKEN: github, GH_TOKEN: gh },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  },
);

test("missing environment tokens still require gh authentication", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--no-env-file",
      "--eval",
      `const { resolveGitHubToken } = await import(${JSON.stringify(source)}); await resolveGitHubToken();`,
    ],
    { encoding: "utf8", env: { PATH: "/no-github-cli" } },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("gh authentication is unavailable");
});
