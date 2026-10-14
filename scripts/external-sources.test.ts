/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  assertExternalArchiveUrl,
  assertExternalSourceEvidence,
  assertExternalSourceUrl,
  externalWorkKey,
} from "../src/lib/external-sources";

const SOURCE = "https://example.com/a";

describe("assertExternalSourceUrl canonical hosts", () => {
  it("accepts the canonical form for each platform", () => {
    expect(
      assertExternalSourceUrl("https://x.com/someone/status/123", "x", "url"),
    ).toBe("https://x.com/someone/status/123");
    expect(
      assertExternalSourceUrl(
        "https://discord.com/channels/1/2/3",
        "discord",
        "url",
      ),
    ).toBe("https://discord.com/channels/1/2/3");
    expect(
      assertExternalSourceUrl(
        "https://www.youtube.com/watch?v=ABCDEFGHIJK",
        "youtube",
        "url",
      ),
    ).toBe("https://www.youtube.com/watch?v=ABCDEFGHIJK");
    expect(
      assertExternalSourceUrl("https://blog.example.org/post-1", "web", "url"),
    ).toBe("https://blog.example.org/post-1");
  });

  it("rejects reserved hosts in the web form", () => {
    for (const url of [
      "https://github.com/foo/bar",
      "https://gist.github.com/foo/1",
      "https://youtu.be/ABCDEFGHIJK",
    ]) {
      expect(() => assertExternalSourceUrl(url, "web", "url")).toThrow();
    }
  });

  it("rejects a trailing-dot host, which names the same host in a second form", () => {
    for (const [url, platform] of [
      ["https://github.com./foo/bar", "web"],
      ["https://x.com./someone/status/123", "web"],
      ["https://x.com./someone/status/123", "x"],
      ["https://blog.example.org./post-1", "web"],
    ] as const) {
      expect(() => assertExternalSourceUrl(url, platform, "url")).toThrow();
    }
  });

  it("rejects explicit empty fragments and empty queries", () => {
    for (const [url, platform] of [
      ["https://example.com/a#", "web"],
      ["https://example.com/a?x=1#", "web"],
      ["https://example.com/a?", "web"],
      ["https://example.com/a?#", "web"],
      ["https://x.com/someone/status/123#", "x"],
      ["https://x.com/someone/status/123?", "x"],
      ["https://www.youtube.com/watch?v=ABCDEFGHIJK#", "youtube"],
    ] as const) {
      expect(() => assertExternalSourceUrl(url, platform, "url")).toThrow();
    }
    // A `?` inside a non-empty query is query content, not an empty query.
    expect(
      assertExternalSourceUrl(
        "https://example.com/search?q=what?",
        "web",
        "url",
      ),
    ).toBe("https://example.com/search?q=what?");
  });

  it("keeps one work key for one piece of work", () => {
    expect(externalWorkKey("https://x.com/alice/status/123", "x")).toBe(
      externalWorkKey("https://x.com/bob/status/123", "x"),
    );
    expect(
      externalWorkKey("https://www.youtube.com/watch?v=ABCDEFGHIJK", "youtube"),
    ).toBe("youtube\0video\0ABCDEFGHIJK");
  });
});

describe("assertExternalArchiveUrl exact binding", () => {
  it("accepts a Wayback capture of the exact source", () => {
    expect(
      assertExternalArchiveUrl(
        "https://web.archive.org/web/20260101000000/https://example.com/a",
        SOURCE,
        "archiveUrl",
      ),
    ).toContain("web.archive.org");
    expect(
      assertExternalArchiveUrl(
        "https://archive.ph/AbCdEf",
        SOURCE,
        "archiveUrl",
      ),
    ).toContain("archive.ph");
  });

  it("accepts a Wayback capture whose target carries the exact query", () => {
    expect(
      assertExternalArchiveUrl(
        "https://web.archive.org/web/20260101000000/https://example.com/a?x=1",
        "https://example.com/a?x=1",
        "archiveUrl",
      ),
    ).toContain("web.archive.org");
    expect(
      assertExternalArchiveUrl(
        "https://web.archive.org/web/20260101000000/https://www.youtube.com/watch?v=ABCDEFGHIJK",
        "https://www.youtube.com/watch?v=ABCDEFGHIJK",
        "archiveUrl",
      ),
    ).toContain("web.archive.org");
  });

  it("rejects a Wayback capture whose target query differs", () => {
    for (const url of [
      "https://web.archive.org/web/20260101000000/https://example.com/a?other=1",
      "https://web.archive.org/web/20260101000000/https://example.com/a?x=2",
    ]) {
      expect(() =>
        assertExternalArchiveUrl(url, SOURCE, "archiveUrl"),
      ).toThrow();
      expect(() =>
        assertExternalArchiveUrl(
          url,
          "https://example.com/a?x=1",
          "archiveUrl",
        ),
      ).toThrow();
    }
  });

  it("requires a byte-equivalent target, with no scheme downgrade", () => {
    expect(() =>
      assertExternalArchiveUrl(
        "https://web.archive.org/web/20260101000000id_/http://example.com/a",
        SOURCE,
        "archiveUrl",
      ),
    ).toThrow();
  });

  it("preserves percent encoding in the captured target", () => {
    expect(
      assertExternalArchiveUrl(
        "https://web.archive.org/web/20260101000000/https://example.com/a%20b",
        "https://example.com/a%20b",
        "archiveUrl",
      ),
    ).toContain("web.archive.org");
    expect(() =>
      assertExternalArchiveUrl(
        "https://web.archive.org/web/20260101000000/https://example.com/a%2520b",
        "https://example.com/a%20b",
        "archiveUrl",
      ),
    ).toThrow();
  });

  it("rejects a Wayback capture of a different URL that ends with the source string", () => {
    for (const url of [
      "https://web.archive.org/web/20260101000000/https://badexample.com/a",
      "https://web.archive.org/web/20260101000000/https://other.org/example.com/a",
      "https://web.archive.org/web/20260101000000/https://example.com/ab",
      "https://web.archive.org/web/20260101000000/https://example.com/a/extra",
    ]) {
      expect(() =>
        assertExternalArchiveUrl(url, SOURCE, "archiveUrl"),
      ).toThrow();
    }
  });

  it("rejects archive URLs with explicit empty delimiters", () => {
    for (const url of [
      "https://web.archive.org/web/20260101000000/https://example.com/a?",
      "https://web.archive.org/web/20260101000000/https://example.com/a#",
    ]) {
      expect(() =>
        assertExternalArchiveUrl(url, SOURCE, "archiveUrl"),
      ).toThrow();
    }
    // The empty-query source itself is rejected, so no source is left
    // whose exact capture the archive check would refuse.
    expect(() =>
      assertExternalArchiveUrl(
        "https://web.archive.org/web/20260101000000/https://example.com/a?",
        "https://example.com/a?",
        "archiveUrl",
      ),
    ).toThrow();
  });

  it("rejects a trailing-dot archive host", () => {
    expect(() =>
      assertExternalArchiveUrl(
        "https://web.archive.org./web/20260101000000/https://example.com/a",
        SOURCE,
        "archiveUrl",
      ),
    ).toThrow();
  });

  it("binds evidence to the exact source through assertExternalSourceEvidence", () => {
    const evidence = {
      archiveUrl:
        "https://web.archive.org/web/20260101000000/https://example.com/a",
      contentSha256: "a".repeat(64),
      capturedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(assertExternalSourceEvidence(evidence, SOURCE, "evidence")).toEqual(
      evidence,
    );
    expect(() =>
      assertExternalSourceEvidence(
        {
          ...evidence,
          archiveUrl:
            "https://web.archive.org/web/20260101000000/https://badexample.com/a",
        },
        SOURCE,
        "evidence",
      ),
    ).toThrow();
  });
});
