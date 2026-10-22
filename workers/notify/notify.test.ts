import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_APPLICATION_NOTICE_PATH,
  type ProjectApplicationNotice,
} from "./contracts";
import { handleNotifyRequest, type NotifyWorkerDependencies } from "./handler";

const ADMINS = ["admin-one@example.test", "admin-two@example.test"];
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const NOW = new Date("2026-10-11T12:00:05.000Z");
const ENDPOINT = `https://notify.internal${PROJECT_APPLICATION_NOTICE_PATH}`;

const NOTICE: ProjectApplicationNotice = {
  applicationId: "app_0123456789abcdef",
  projectId: "example-project",
  projectName: "Example Project",
  repository: "example-org/example-repo",
  applicantLogin: "octo-cat",
  submittedAt: "2026-10-11T12:00:00.000Z",
  reviewUrl: "https://slop.cash/admin/applications/app_0123456789abcdef",
};

type Sent = { from: string; to: string; raw: string };

function harness(fail: (to: string) => boolean = () => false) {
  const sent: Sent[] = [];
  let counter = 0;
  const deps: NotifyWorkerDependencies = {
    adminEmails: ADMINS.join(", "),
    fromAddress: "notifications@slop.cash",
    now: () => NOW,
    randomId: () => `msg-${String(++counter).padStart(16, "0")}`,
    sendEmail: async (from, to, raw) => {
      if (fail(to)) throw new Error("destination rejected");
      sent.push({ from, to, raw });
    },
  };
  return { deps, sent };
}

function post(body: unknown, url = ENDPOINT, init: RequestInit = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function splitMime(raw: string): { headers: string[]; body: string } {
  const separator = raw.indexOf("\r\n\r\n");
  expect(separator).toBeGreaterThan(0);
  return {
    headers: raw.slice(0, separator).split("\r\n"),
    body: raw.slice(separator + 4),
  };
}

function decodeQuotedPrintable(body: string): string {
  const joined = body.replace(/=\r\n/gu, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === "=") {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

afterEach(() => {
  mock.restore();
});

describe("slop notify worker", () => {
  it("sends one well-formed plain-text email to each admin", async () => {
    const { deps, sent } = harness();
    const response = await handleNotifyRequest(post(NOTICE), deps);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(await response.json()).toEqual({ status: "sent", recipients: 2 });
    expect(sent.map((message) => message.to)).toEqual(ADMINS);

    for (const message of sent) {
      expect(message.from).toBe("notifications@slop.cash");
      expect(message.raw).not.toMatch(/(?<!\r)\n|\r(?!\n)/u);
      const { headers, body } = splitMime(message.raw);
      expect(headers).toEqual([
        "From: notifications@slop.cash",
        `To: ${message.to}`,
        "Subject: New Slop project application: Example Project",
        "Date: Sun, 11 Oct 2026 12:00:05 +0000",
        expect.stringMatching(/^Message-ID: <msg-\d{16}@slop\.cash>$/u),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
      ]);
      for (const line of body.split("\r\n")) {
        expect(line.length).toBeLessThanOrEqual(76);
      }
      expect(decodeQuotedPrintable(body)).toBe(
        [
          "A person submitted a new project application to Slop.",
          "",
          "Project name: Example Project",
          "Project id: example-project",
          "Repository: https://github.com/example-org/example-repo",
          "Applicant: octo-cat (https://github.com/octo-cat)",
          "Submitted at: 2026-10-11T12:00:00.000Z",
          "Application id: app_0123456789abcdef",
          "",
          `Review it in the admin panel: ${NOTICE.reviewUrl}`,
          "",
        ].join("\r\n"),
      );
    }
    expect(splitMime(sent[0].raw).headers[4]).not.toBe(
      splitMime(sent[1].raw).headers[4],
    );
  });

  it("encodes a non-ASCII subject with RFC 2047", async () => {
    const { deps, sent } = harness();
    const projectName = "Ünïcødé 项目 ".repeat(5).trim();
    const response = await handleNotifyRequest(
      post({ ...NOTICE, projectName }),
      deps,
    );
    expect(response.status).toBe(202);
    const { headers, body } = splitMime(sent[0].raw);
    const start = headers.findIndex((line) => line.startsWith("Subject: "));
    const subjectLines = [headers[start]];
    for (let i = start + 1; headers[i]?.startsWith(" "); i += 1) {
      subjectLines.push(headers[i]);
    }
    expect(subjectLines.length).toBeGreaterThan(1);
    const words = subjectLines.map((line) =>
      line.replace(/^(Subject:)? /u, ""),
    );
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/u);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    const decoded = words
      .map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(`New Slop project application: ${projectName}`);
    expect(decodeQuotedPrintable(body)).toContain(
      `Project name: ${projectName}\r\n`,
    );
  });

  it("cannot add a header through the project name", async () => {
    const { deps, sent } = harness();
    const response = await handleNotifyRequest(
      post({
        ...NOTICE,
        projectName: `X\r\nBcc: evil@x${LINE_SEPARATOR}Cc: evil@y`,
      }),
      deps,
    );
    expect(response.status).toBe(202);
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      const { headers } = splitMime(message.raw);
      expect(headers).toHaveLength(8);
      expect(headers.some((line) => /^(Bcc|Cc):/iu.test(line))).toBe(false);
      expect(headers[2]).toBe(
        "Subject: New Slop project application: XBcc: evil@xCc: evil@y",
      );
    }
  });

  it.each([
    [
      "wrong host",
      post(NOTICE, "https://notify.slop.cash/v1/project-applications"),
      404,
    ],
    ["wrong path", post(NOTICE, "https://notify.internal/v1/other"), 404],
    ["query string", post(NOTICE, `${ENDPOINT}?x=1`), 404],
    ["wrong method", new Request(ENDPOINT, { method: "GET" }), 405],
    ["not JSON", post("{not json"), 400],
    ["array body", post([NOTICE]), 400],
    ["extra key", post({ ...NOTICE, extra: "x" }), 400],
    ["missing key", post({ ...NOTICE, reviewUrl: undefined }), 400],
    ["non-string field", post({ ...NOTICE, projectId: 7 }), 400],
    ["bad project id", post({ ...NOTICE, projectId: "Bad_Id" }), 400],
    ["empty name", post({ ...NOTICE, projectName: "\r\n" }), 400],
    ["long name", post({ ...NOTICE, projectName: "x".repeat(81) }), 400],
    ["bad repository", post({ ...NOTICE, repository: "a/b/c" }), 400],
    ["bad login", post({ ...NOTICE, applicantLogin: "-octo" }), 400],
    [
      "no milliseconds",
      post({ ...NOTICE, submittedAt: "2026-10-11T12:00:00Z" }),
      400,
    ],
    [
      "impossible date",
      post({ ...NOTICE, submittedAt: "2026-02-30T12:00:00.000Z" }),
      400,
    ],
    [
      "staging review URL in production",
      post({ ...NOTICE, reviewUrl: "https://staging.slop.cash/admin" }),
      400,
    ],
    [
      "foreign review URL",
      post({ ...NOTICE, reviewUrl: "https://slop.cash.evil/admin" }),
      400,
    ],
    [
      "review URL lookalike",
      post({ ...NOTICE, reviewUrl: "https://slop.cash/administrator" }),
      400,
    ],
    [
      "review URL newline",
      post({ ...NOTICE, reviewUrl: "https://slop.cash/admin/\nx" }),
      400,
    ],
    [
      "wrong content type",
      post(NOTICE, ENDPOINT, { headers: { "content-type": "text/plain" } }),
      400,
    ],
    [
      "oversized body",
      post(JSON.stringify({ ...NOTICE, pad: "x".repeat(9000) })),
      400,
    ],
  ])("rejects %s without sending", async (_label, request, status) => {
    const { deps, sent } = harness();
    const response = await handleNotifyRequest(request, deps);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error:
        status === 404
          ? "not_found"
          : status === 405
            ? "method_not_allowed"
            : "invalid_request",
    });
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["header injection", "admin-one@example.test\r\nBcc: evil@example.test"],
    ["duplicate", "admin-one@example.test,ADMIN-ONE@example.test"],
  ])("refuses a %s admin list without sending", async (_label, adminEmails) => {
    spyOn(console, "error").mockImplementation(() => {});
    const { deps, sent } = harness();
    const response = await handleNotifyRequest(post(NOTICE), {
      ...deps,
      adminEmails,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "service_misconfigured" });
    expect(sent).toHaveLength(0);
  });

  it("refuses an invalid sender address without sending", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const { deps, sent } = harness();
    const response = await handleNotifyRequest(post(NOTICE), {
      ...deps,
      fromAddress: "notifications@slop.cash\r\nBcc: evil@x",
    });
    expect(response.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it("reports a failed delivery without claiming success", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const { deps, sent } = harness((to) => to === ADMINS[0]);
    const response = await handleNotifyRequest(post(NOTICE), deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "delivery_failed",
      sent: 1,
    });
    expect(sent.map((message) => message.to)).toEqual([ADMINS[1]]);
  });

  it("keeps recipients and routes out of wrangler.toml", () => {
    const toml = readFileSync(
      join(process.cwd(), "workers/notify/wrangler.toml"),
      "utf8",
    );
    expect(toml).not.toMatch(/@(?!slop\.cash")[A-Za-z0-9.-]+/u);
    expect(toml).toMatch(
      /^NOTIFY_FROM_ADDRESS = "notifications@slop\.cash"$/mu,
    );
    expect(toml).not.toMatch(/^routes\s*=/mu);
    expect(toml).toMatch(/^workers_dev = false$/mu);
  });
});
