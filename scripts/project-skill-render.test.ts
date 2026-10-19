// Generated project skills: deterministic bytes, a digest that binds the
// template commit and the manifest revision, and archives that install.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { assertProjectDefinition } from "../src/lib/project-schema.mjs";
import {
  CONTRIBUTOR_TEMPLATE_PATH,
  REVIEWER_TEMPLATE_PATH,
  renderProjectSkills,
  SKILL_KIT_FILES,
  SKILL_KIT_PATH,
  type SkillTemplateIndex,
  sha256Hex,
} from "../src/lib/project-skill-render.mjs";
import type { ProjectDefinition } from "../src/lib/projects.mjs";
import { applicationManifest } from "../tests/project-application-manifest";
import { pythonCommand } from "./skill-python.mjs";

const root = resolve(import.meta.dir, "..");
const COMMIT = "a".repeat(40);

function files(path: string): string[] {
  const absolute = join(root, path);
  return readdirSync(absolute, { recursive: true })
    .map(String)
    .filter((entry) => statSync(join(absolute, entry)).isFile())
    .map((entry) => relative(absolute, join(absolute, entry)))
    .sort();
}

async function group(sourcePath: string, paths: string[]) {
  return {
    sourcePath,
    files: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: await sha256Hex(readFileSync(join(root, sourcePath, path))),
      })),
    ),
  };
}

async function templateIndex(): Promise<SkillTemplateIndex> {
  return {
    schemaVersion: "1",
    repository: "SlopDotCash/slopdotcash",
    commit: COMMIT,
    revisionStatus: "committed",
    contributor: await group(
      CONTRIBUTOR_TEMPLATE_PATH,
      files(CONTRIBUTOR_TEMPLATE_PATH),
    ),
    reviewer: await group(
      REVIEWER_TEMPLATE_PATH,
      files(REVIEWER_TEMPLATE_PATH),
    ),
    scripts: await group(SKILL_KIT_PATH, [...SKILL_KIT_FILES]),
  };
}

const readFile = async (path: string) =>
  new Uint8Array(readFileSync(join(root, path)));

function manifest(overrides: Record<string, unknown> = {}): ProjectDefinition {
  return assertProjectDefinition(
    applicationManifest("open-registry", "example/open-registry", {
      rewardAsset: {
        network: "ethereum",
        kind: "stablecoin",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        decimals: 6,
        chainId: "1",
        cluster: null,
        verifiedAt: "2026-10-18T00:00:00.000Z",
      },
      ...overrides,
    }),
  );
}

async function render(
  value: ProjectDefinition,
  revision = 3,
  manifestSha256 = "b".repeat(64),
) {
  return renderProjectSkills({
    template: await templateIndex(),
    readFile,
    manifest: value,
    revision,
    manifestSha256,
    publicOrigin: "https://slop.cash",
  });
}

describe("generated project skills", () => {
  test("render byte-identical skills and archives from the same inputs", async () => {
    const first = await render(manifest());
    const second = await render(manifest());
    expect(Buffer.from(first.contributor.archive)).toEqual(
      Buffer.from(second.contributor.archive),
    );
    expect(first.contributor.provenance.digest).toBe(
      second.contributor.provenance.digest,
    );
    expect(first.contributor.provenance.skillRevision).toBe(
      `SlopDotCash/slopdotcash@${COMMIT}:skills/contribute-to-project+open-registry@3#sha256:${first.contributor.provenance.digest}`,
    );
    const skill = new TextDecoder().decode(first.contributor.skillMarkdown);
    expect(skill).toContain("name: contribute-to-open-registry");
    expect(skill).toContain("security@example.org");
    expect(skill).toContain(
      "Reward asset: USDC (network stablecoin) on Ethereum",
    );
    expect(skill).not.toMatch(/\{\{[A-Za-z]+\}\}/u);
  });

  test("bind the digest to the manifest revision and its SHA-256", async () => {
    const base = await render(manifest());
    const nextRevision = await render(manifest(), 4);
    const otherDigest = await render(manifest(), 3, "c".repeat(64));
    expect(nextRevision.contributor.provenance.digest).not.toBe(
      base.contributor.provenance.digest,
    );
    expect(otherDigest.contributor.provenance.digest).not.toBe(
      base.contributor.provenance.digest,
    );
  });

  test("never re-expand template fields inside maintainer text", async () => {
    const value = manifest({
      skillContent: {
        ...(manifest().skillContent as Record<string, string>),
        scope:
          "Literal {{securityContact}} and {{projectId}} stay as typed here.",
      },
    });
    const skill = new TextDecoder().decode(
      (await render(value)).contributor.skillMarkdown,
    );
    expect(skill).toContain(
      "Literal {{securityContact}} and {{projectId}} stay as typed here.",
    );
  });

  test("refuse a template file whose bytes differ from the published digest", async () => {
    const template = await templateIndex();
    await expect(
      renderProjectSkills({
        template,
        readFile: async (path) =>
          path.endsWith("SKILL.md")
            ? new TextEncoder().encode("forged")
            : readFile(path),
        manifest: manifest(),
        revision: 1,
        manifestSha256: "b".repeat(64),
        publicOrigin: "https://slop.cash",
      }),
    ).rejects.toThrow("does not match its digest");
  });

  test("refuse a project without skill content", async () => {
    const { skillContent: _content, ...rest } = manifest() as unknown as Record<
      string,
      unknown
    >;
    await expect(
      render(assertProjectDefinition(rest) as ProjectDefinition),
    ).rejects.toThrow("has no skill content");
  });

  test("archives extract, validate, and disclose the generated revision", async () => {
    const rendered = await render(manifest());
    const workspace = mkdtempSync(join(tmpdir(), "slop-generated-skill-"));
    try {
      for (const skill of [rendered.contributor, rendered.reviewer]) {
        const archive = join(workspace, `${skill.name}.skill`);
        writeFileSync(archive, skill.archive);
        const python = pythonCommand(root);
        execFileSync(
          python.executable,
          [...python.prefix, "-m", "zipfile", "-e", archive, workspace],
          { stdio: "pipe" },
        );
        execFileSync(
          python.executable,
          [
            ...python.prefix,
            join(root, "scripts", "skill-validation", "quick_validate.py"),
            join(workspace, skill.name),
          ],
          { stdio: "pipe" },
        );
        const provenance = JSON.parse(
          readFileSync(join(workspace, skill.name, "PROVENANCE.json"), "utf8"),
        );
        expect(provenance.digest).toBe(skill.provenance.digest);
      }
      const disclose = spawnSync(
        process.execPath,
        [
          join(
            workspace,
            rendered.contributor.name,
            "scripts",
            "run-receipt.mjs",
          ),
          "disclose",
          "--provider",
          "anthropic",
          "--model",
          "claude-opus-5-5",
          "--client",
          "claude-code",
        ],
        { encoding: "utf8" },
      );
      expect(disclose.status).toBe(0);
      expect(disclose.stdout).toContain("Made via @slopdotcash");
      expect(disclose.stdout).toContain(
        `Contribution skill revision: ${rendered.contributor.provenance.skillRevision}`,
      );
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
