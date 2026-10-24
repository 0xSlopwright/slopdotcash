// Private-intake listing pagination against recorded GitHub response shapes.
// No network is used. A complete empty list is what reconcile treats as
// permission to send the same report again.
import { describe, expect, test } from "bun:test";
import {
  githubAdvisoryClient,
  markerLine,
  reporterGrant,
} from "./github-advisories";

const API = "https://api.github.invalid";
const REPOSITORY = "example/bounty";
const AUTHOR_ID = 900000102;
const MARKER = markerLine("a1b2c3d4e5f60718293a4b5c6d7e8f90");
const SINCE = "2026-10-19T00:00:00.000Z";

function firstUrl(): string {
  const url = new URL(`${API}/repos/${REPOSITORY}/security-advisories`);
  url.searchParams.set("sort", "created");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");
  return url.href;
}

function advisory(overrides: Record<string, unknown> = {}) {
  const ghsa =
    typeof overrides.ghsa_id === "string"
      ? overrides.ghsa_id
      : "GHSA-7c8f-9g2h-3j4m";
  return {
    ghsa_id: ghsa,
    html_url: `https://github.com/${REPOSITORY}/security/advisories/${ghsa}`,
    created_at: "2026-10-19T12:00:00Z",
    state: "triage",
    summary: "Vault share rounding",
    description: "Steps to reproduce on a local fork.",
    severity: "high",
    submission: { accepted: false },
    author: { id: AUTHOR_ID, login: "reporter" },
    ...overrides,
  };
}

function client(pages: Record<string, Response>) {
  const requested: string[] = [];
  const advisories = githubAdvisoryClient({
    apiOrigin: API,
    installation: { installed: async () => "yes" },
    fetch: async (url) => {
      requested.push(url);
      return pages[url] ?? new Response("missing", { status: 404 });
    },
  });
  return { advisories, requested };
}

function grant() {
  return reporterGrant("fixture-token", String(AUTHOR_ID));
}

const newerUnrelated = advisory({
  ghsa_id: "GHSA-2c3f-4g5h-6j7m",
  description: "A different report.",
});

const marked = advisory({
  created_at: "2026-10-19T11:00:00Z",
  description: `Local steps.\n${MARKER}\n`,
});

describe("private advisory listing", () => {
  test("follows GitHub's repository-id next link to the marked report", async () => {
    const first = firstUrl();
    const second = `${API}/repositories/1300192/security-advisories?page=2`;
    const { advisories, requested } = client({
      [first]: Response.json([newerUnrelated], {
        headers: {
          link: `<${second}>; rel="next", <${API}/repositories/1300192/security-advisories?page=3>; rel="last"`,
        },
      }),
      [second]: Response.json([marked]),
    });
    const result = await advisories.findByMarker(
      grant(),
      REPOSITORY,
      MARKER,
      SINCE,
    );
    expect(requested).toEqual([first, second]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.matches.map((match) => match.ghsa)).toEqual([
      "GHSA-7c8f-9g2h-3j4m",
    ]);
    expect(result.matches[0]?.authorId).toBe(String(AUTHOR_ID));
    expect(result.matches[0]?.markerFound).toBe(true);
  });

  test("a failed later repository-id page is an error, not an empty listing", async () => {
    const first = firstUrl();
    const second = `${API}/repositories/1300192/security-advisories?page=2`;
    const { advisories, requested } = client({
      [first]: Response.json([newerUnrelated], {
        headers: { link: `<${second}>; rel="next"` },
      }),
      [second]: new Response("upstream", { status: 502 }),
    });
    const result = await advisories.findByMarker(
      grant(),
      REPOSITORY,
      MARKER,
      SINCE,
    );
    expect(requested).toEqual([first, second]);
    expect(result).toEqual({ kind: "error" });
  });

  test("a next link that is not this listing is an error, not a complete list", async () => {
    const first = firstUrl();
    const refused = [
      '<https://elsewhere.invalid/security-advisories?page=2>; rel="next"',
      `<${API}/repositories/1300192/issues?page=2>; rel="next"`,
      '<not a url>; rel="next"',
    ];
    for (const link of refused) {
      const { advisories, requested } = client({
        [first]: Response.json([newerUnrelated], { headers: { link } }),
      });
      const result = await advisories.findByMarker(
        grant(),
        REPOSITORY,
        MARKER,
        SINCE,
      );
      expect(result).toEqual({ kind: "error" });
      expect(requested).toEqual([first]);
    }
  });

  test("a same-path next link is still followed", async () => {
    const first = firstUrl();
    const second = new URL(first);
    second.searchParams.set("page", "2");
    const { advisories, requested } = client({
      [first]: Response.json([newerUnrelated], {
        headers: { link: `<${second.href}>; rel="next"` },
      }),
      [second.href]: Response.json([marked]),
    });
    const result = await advisories.findByMarker(
      grant(),
      REPOSITORY,
      MARKER,
      SINCE,
    );
    expect(requested).toEqual([first, second.href]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.matches.map((match) => match.ghsa)).toEqual([
      "GHSA-7c8f-9g2h-3j4m",
    ]);
  });

  test("one page with no next link returns the marked report", async () => {
    const first = firstUrl();
    const { advisories, requested } = client({
      [first]: Response.json([marked]),
    });
    const result = await advisories.findByMarker(
      grant(),
      REPOSITORY,
      MARKER,
      SINCE,
    );
    expect(requested).toEqual([first]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.matches).toHaveLength(1);
  });

  test("a page that reaches the since window stops without the next link", async () => {
    const first = firstUrl();
    const second = `${API}/repositories/1300192/security-advisories?page=2`;
    const { advisories, requested } = client({
      [first]: Response.json(
        [advisory({ created_at: "2026-10-18T23:00:00Z" })],
        { headers: { link: `<${second}>; rel="next"` } },
      ),
      [second]: Response.json([marked]),
    });
    const result = await advisories.findByMarker(
      grant(),
      REPOSITORY,
      MARKER,
      SINCE,
    );
    expect(requested).toEqual([first]);
    expect(result).toEqual({ kind: "complete", matches: [] });
  });
});
