import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { projectLinks } from "../src/lib/project-links";
import { assertProjectDefinition } from "../src/lib/project-schema.mjs";
import type { ProjectDefinition } from "../src/lib/projects.mjs";

function manifest(id: string): ProjectDefinition {
  return JSON.parse(readFileSync(`projects/${id}/project.json`, "utf8"));
}

describe("project X link", () => {
  test("accepts an X profile", () => {
    const project = manifest("eliza");
    expect(project.links.x).toBe("https://x.com/elizaOS");
    expect(() => assertProjectDefinition(project)).not.toThrow();
  });

  test.each([
    "https://twitter.com/elizaOS",
    "https://x.com.example.net/elizaOS",
    "https://x.com/elizaOS/status/2087086460868645089",
    "https://x.com/elizaOS?ref=slop",
    "https://x.com/",
  ])("refuses %s", (href) => {
    const project = manifest("eliza");
    const links = { ...project.links, x: href };
    expect(() => assertProjectDefinition({ ...project, links })).toThrow(
      /project\.links\.x/u,
    );
  });
});

describe("projectLinks", () => {
  test("leads with the website and X account", () => {
    expect(projectLinks(manifest("eliza")).map((link) => link.label)).toEqual([
      "elizaos.ai",
      "@elizaOS on X",
      "GitHub",
      "Issues",
      "Discussions",
    ]);
  });

  test("shows a links.website when the steward has none", () => {
    const links = projectLinks(manifest("thenetwork"));
    expect(links[0]).toEqual({
      href: "https://ntwrk.party",
      label: "ntwrk.party",
    });
  });

  test("lists a URL the website already shows once", () => {
    const links = projectLinks(manifest("delta-star"));
    expect(links.map((link) => link.label)).toEqual([
      "proximityprize.org",
      "GitHub",
      "Issues",
      "Discussions",
      "Mission",
    ]);
  });
});
