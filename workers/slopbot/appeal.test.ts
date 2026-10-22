import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdirSync } from "node:fs";
import { findProject } from "../../src/lib/projects.mjs";
import { sqliteD1 } from "../../tests/sqlite-d1";
import worker from "./index";

test("appeal queue retries unconfirmed labels and acknowledges confirmed retry once", async () => {
  const { db, sqlite } = sqliteD1(
    readdirSync(new URL("../../migrations/", import.meta.url))
      .filter((p) => p.endsWith(".sql"))
      .sort(),
  );
  const project = findProject("asi");
  assert.ok(project);
  const manifest = JSON.stringify(project),
    digest = createHash("sha256").update(manifest).digest("hex"),
    at = "2026-10-21T00:00:00.000Z";
  sqlite.run(
    "INSERT INTO project_revisions(project_id,revision,manifest,manifest_sha256,reason,created_at) VALUES (?,1,?,?,?,?)",
    [project.id, manifest, digest, "local regression fixture", at],
  );
  sqlite.run(
    "INSERT INTO projects(id,status,revision,manifest,manifest_sha256,created_at,updated_at) VALUES (?,?,1,?,?,?,?)",
    [project.id, project.status, manifest, digest, at, at],
  );
  const [owner, repo] = new URL(project.repositories[0].githubUrl).pathname
    .slice(1)
    .split("/");
  sqlite.run(
    "INSERT INTO project_repositories(repository_key,project_id) VALUES (?,?)",
    [`${owner}/${repo}`.toLowerCase(), project.id],
  );
  let labelStatus = 404;
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path.endsWith("/access_tokens"))
        return Response.json({ token: "local-synthetic-token" });
      if (path.endsWith("/labels"))
        return labelStatus === 200
          ? Response.json([{ name: "slopbot: appeal" }])
          : new Response(null, { status: labelStatus });
      if (path.endsWith("/issues/1"))
        return Response.json({
          node_id: "I_local",
          number: 1,
          state: "closed",
          title: "local fixture",
          body: "appeal",
          user: { login: "author", id: 42, type: "User" },
          assignees: [],
        });
      if (path === `/repos/${owner}/${repo}`)
        return Response.json({
          id: Number(project.authority.repositoryId),
          private: false,
          default_branch: "main",
          owner: { login: owner, id: 77, type: "Organization" },
        });
      throw Error("unexpected local request " + path);
    },
  });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((
    url: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    const u = new URL(url instanceof Request ? url.url : String(url));
    assert.equal(u.hostname, "api.github.com");
    return nativeFetch(new URL(u.pathname + u.search, server.url), init);
  }) as typeof fetch;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env = {
    SLOPBOT_DB: db,
    SLOPBOT_APP_ID: "1",
    SLOPBOT_APP_PRIVATE_KEY: privateKey,
    SLOPBOT_APP_USER_ID: "999",
    SLOPBOT_WEBHOOK_SECRET: "local-only",
    SLOPBOT_QUEUE: { async send() {} },
  };
  const outcomes = [];
  try {
    for (const status of [404, 302, 200]) {
      labelStatus = status;
      let ack = 0,
        retry = 0;
      await worker.queue(
        {
          messages: [
            {
              body: {
                kind: "appeal",
                deliveryId: "local-" + status,
                installationId: 1,
                repositoryId: Number(project.authority.repositoryId),
                owner,
                repo,
                itemKind: "issue",
                number: 1,
                senderId: 42,
              },
              ack() {
                ack++;
              },
              retry() {
                retry++;
              },
            },
          ],
        },
        env,
      );
      outcomes.push({ status, ack, retry });
    }
    assert.equal(calls.filter((call) => call.endsWith("/labels")).length, 3);
    assert.deepEqual(
      sqlite.query("SELECT COUNT(*) AS n FROM slopbot_actions").get(),
      { n: 1 },
    );
    assert.deepEqual(outcomes, [
      { status: 404, ack: 0, retry: 1 },
      { status: 302, ack: 0, retry: 1 },
      { status: 200, ack: 1, retry: 0 },
    ]);
  } finally {
    globalThis.fetch = nativeFetch;
    server.stop(true);
    sqlite.close();
  }
});
