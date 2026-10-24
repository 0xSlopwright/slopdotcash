// Owner decisions D6, D7 and D8: closure of a verified Slop-skill member, the
// published penalty table, and Slopbot-first appeal triage with moderator
// escalation. The real worker runs against the real migrations, a local
// synthetic GitHub server and a local synthetic model endpoint; nothing
// leaves this process.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdirSync } from "node:fs";
import { loadPenaltyDebits } from "../../scripts/penalty-ingestion";
import { ValueFeedUnavailableError } from "../../scripts/value-ingestion";
import { createLeaderboardSnapshot } from "../../src/lib/leaderboard";
import type {
  GitHubActor,
  LeaderboardInput,
  PenaltyDebitRecord,
} from "../../src/lib/leaderboard-types";
import { createPaymentProjectView } from "../../src/lib/project-view";
import { findProject } from "../../src/lib/projects.mjs";
import { TARGET_REPOSITORIES } from "../../src/lib/repositories.mjs";
import { sqliteD1 } from "../../tests/sqlite-d1";
import type { Category, Job } from "./contracts";
import worker from "./index";
import type { D1TransactionalDatabase } from "./persistence";
import { type ReviewEnv, reviewItem } from "./review";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

afterEach(() => setSystemTime());

const AUTHOR = 42;
const MAINTAINER = 43;
const OUTSIDER = 44;
const MODERATOR = 50;
const BODY = "Buy cheap followers today at our shop.";

type Run = {
  review: () => Promise<string>;
  deliver: (job: Job) => Promise<string>;
  tick: () => Promise<Job[]>;
  model: (category: Category, confidence: number) => void;
  pauseNextReopen: () => { entered: Promise<void>; release: () => void };
  loseNextReopenResponse: () => void;
  closeByMaintainer: () => void;
  writes: string[];
  comments: string[];
  labels: string[];
  sql: (q: string) => unknown;
  job: (kind: string, extra: Record<string, unknown>) => Job;
  /** The worker's public HTTP routes, with this run's real database. */
  fetchWorker: (request: Request) => Promise<Response>;
};

async function closedItem(cb: (run: Run) => Promise<void>) {
  const { db, sqlite } = sqliteD1(
    readdirSync(new URL("../../migrations/", import.meta.url))
      .filter((p) => p.endsWith(".sql"))
      .sort(),
  );
  const project = findProject("asi");
  if (!project) throw new Error("fixture project missing");
  const manifest = JSON.stringify({ ...project, status: "active" });
  const digest = createHash("sha256").update(manifest).digest("hex");
  const at = "2026-01-01T00:00:00.000Z";
  sqlite.run(
    "INSERT INTO project_revisions(project_id,revision,manifest,manifest_sha256,reason,created_at) VALUES (?,1,?,?,?,?)",
    [project.id, manifest, digest, "local regression fixture", at],
  );
  sqlite.run(
    "INSERT INTO projects(id,status,revision,manifest,manifest_sha256,created_at,updated_at) VALUES (?,?,1,?,?,?,?)",
    [project.id, "active", manifest, digest, at, at],
  );
  const [owner, repo] = new URL(project.repositories[0].githubUrl).pathname
    .slice(1)
    .split("/");
  sqlite.run(
    "INSERT INTO project_repositories(repository_key,project_id) VALUES (?,?)",
    [`${owner}/${repo}`.toLowerCase(), project.id],
  );
  // An installation past its shadow period: 14 days and 50 completed reviews.
  sqlite.run(
    "INSERT INTO slopbot_installations(installation_id, account_id, account_login, account_type, created_at) VALUES (1,77,?,'Organization',?)",
    [owner, at],
  );
  const repositoryId = Number(project.authority.repositoryId);
  for (let i = 0; i < 50; i++)
    sqlite.run(
      `INSERT INTO slopbot_reviews(review_key,installation_id,repository_id,item_kind,item_number,item_node_id,
        author_id,revision,content_digest,policy_digest,status,created_at,completed_at)
       VALUES (?,1,?,'pull_request',?,?,1000,'r','d','p','completed',?,?)`,
      [`shadow-${i}`, repositoryId, 100 + i, `PR_shadow_${i}`, at, at],
    );
  // The verified Slop-skill member (D6): a member record and the author's own
  // authenticated run, whose pull_request_opened event names this node ID.
  sqlite.run(
    "INSERT INTO points_members(actor_id,github_id,login,joined_at,public) VALUES ('actor-42','42','author',?,0)",
    [at],
  );
  sqlite.run(
    `INSERT INTO trace_runs(id,client_run_id,github_user_id,github_login,project_id,repository,
      project_policy_revision,provider,model,client,client_version,state,created_at,create_idempotency_key)
     VALUES ('run-1','client-1','42','author',?,?,?,
      'surplus','claude-opus-5.5','claude-code','1.0.0','awaiting_trace',?,'idem-1')`,
    [project.id, `${owner}/${repo}`, "a".repeat(40), at],
  );
  sqlite.run(
    `INSERT INTO run_progress_events(id,run_id,github_user_id,kind,occurred_at,source,github_object_id,
      github_url,head_sha,created_at,idempotency_key)
     VALUES ('event-1','run-1','42','pull_request_opened',?,'agent','PR_local',NULL,NULL,?,'idem-event-1')`,
    [at, at],
  );

  const writes: string[] = [];
  const comments: string[] = [];
  const labels: string[] = [];
  let state = "open";
  let pauseReopen: (() => Promise<void>) | null = null;
  let loseReopenResponse = false;
  let verdict = { category: "spam" as Category, confidence: 0.97 };
  const config = Buffer.from(
    JSON.stringify({ version: 1, audience: "protection", closure: true }),
  ).toString("base64");
  const login = (id: number) =>
    ({
      [AUTHOR]: "author",
      [MAINTAINER]: "maintainer",
      [OUTSIDER]: "outsider",
      [MODERATOR]: "moderator",
    })[id];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method !== "GET" && !path.endsWith("/access_tokens"))
        writes.push(`${request.method} ${path}`);
      if (path === "/v1/messages")
        return Response.json({
          id: "msg_local",
          type: "message",
          role: "assistant",
          model: "claude-opus-5.5",
          stop_reason: "end_turn",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...verdict,
                rule_refs: [
                  { source: "universal", quote: "Buy cheap followers" },
                ],
                evidence: ["Buy cheap followers"],
                summary: "This pull request advertises a service.",
                limitations: [],
                objective_defect: null,
              }),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        });
      if (path.endsWith("/access_tokens"))
        return Response.json({ token: "local-synthetic-token" });
      if (path === `/repos/${owner}/${repo}`)
        return Response.json({
          id: repositoryId,
          private: false,
          default_branch: "main",
          owner: { login: owner, id: 77, type: "Organization" },
        });
      if (path.endsWith("/contents/.github/slopbot.json"))
        return Response.json({
          type: "file",
          size: 64,
          content: config,
          encoding: "base64",
        });
      if (path.endsWith("/issues/5") && request.method === "GET")
        return Response.json({
          node_id: "PR_local",
          number: 5,
          state,
          title: "Followers",
          body: BODY,
          user: { login: "author", id: AUTHOR, type: "User" },
          assignees: [],
          labels: labels.map((name) => ({ name })),
          pull_request: {},
        });
      if (path.endsWith("/pulls/5") && request.method === "PATCH") {
        const next = ((await request.json()) as { state: string }).state;
        if (next === "open" && pauseReopen) {
          const pause = pauseReopen;
          pauseReopen = null;
          await pause();
        }
        state = next;
        if (next === "open" && loseReopenResponse) {
          loseReopenResponse = false;
          return Response.json(
            { error: "synthetic lost response" },
            { status: 503 },
          );
        }
        return Response.json({ state });
      }
      if (path.endsWith("/pulls/5"))
        return Response.json({
          draft: false,
          merged: false,
          head: { sha: "b".repeat(40) },
          base: { sha: "c".repeat(40) },
          additions: 1,
          deletions: 0,
          changed_files: 1,
        });
      if (path.endsWith("/branches/main"))
        return Response.json({ commit: { sha: "c".repeat(40) } });
      if (path.endsWith("/pulls/5/files"))
        return Response.json(
          url.searchParams.get("page") === "1" || !url.searchParams.has("page")
            ? [
                {
                  filename: "README.md",
                  status: "modified",
                  patch: `+${BODY}`,
                },
              ]
            : [],
        );
      const user = path.match(/^\/user\/(\d+)$/u);
      if (user && login(Number(user[1])))
        return Response.json({
          login: login(Number(user[1])),
          id: Number(user[1]),
        });
      if (path.endsWith("/permission"))
        return Response.json({
          permission: path.includes("/maintainer/") ? "write" : "read",
        });
      if (path.endsWith("/issues/5/comments") && request.method === "GET")
        return Response.json([
          {
            id: 1,
            body: "/slopbot appeal This is my real project page, not an advert.",
            user: { id: AUTHOR },
          },
        ]);
      if (path.endsWith("/issues/5/comments")) {
        comments.push(((await request.json()) as { body: string }).body);
        return Response.json({ id: 900 + comments.length }, { status: 201 });
      }
      if (/\/issues\/comments\/\d+$/u.test(path)) {
        comments.push(((await request.json()) as { body: string }).body);
        return Response.json({ id: Number(path.split("/").pop()) });
      }
      if (path.endsWith("/issues/5/labels")) {
        const body = (await request.json()) as { labels: string[] };
        for (const name of body.labels)
          if (!labels.includes(name)) labels.push(name);
        return Response.json(labels.map((name) => ({ name })));
      }
      const removed = path.match(/\/issues\/5\/labels\/(.+)$/u);
      if (removed && request.method === "DELETE") {
        const name = decodeURIComponent(removed[1]);
        labels.splice(labels.indexOf(name), 1);
        return Response.json([]);
      }
      return new Response(null, { status: 404 });
    },
  });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = ((
    url: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    const u = new URL(url instanceof Request ? url.url : String(url));
    if (u.origin === new URL(server.url).origin) return nativeFetch(url, init);
    if (u.hostname !== "api.github.com")
      throw new Error(`unexpected network request to ${u.hostname}`);
    return nativeFetch(new URL(u.pathname + u.search, server.url), init);
  }) as typeof fetch;
  const sent: Job[] = [];
  const env = {
    SLOPBOT_DB: db as unknown as D1TransactionalDatabase,
    SLOPBOT_APP_ID: "1",
    SLOPBOT_APP_PRIVATE_KEY: privateKey,
    SLOPBOT_APP_USER_ID: "999",
    SLOPBOT_CLOSURE_ENABLED: "true",
    PROJECT_MODERATOR_GITHUB_IDS: String(MODERATOR),
    SURPLUS_API_KEY: "local-synthetic-key",
    SURPLUS_BASE_URL: server.url.origin,
    SLOPBOT_QUEUE: { send: async (job: Job) => void sent.push(job) },
  };
  const base = {
    installationId: 1,
    repositoryId,
    owner,
    repo,
    itemKind: "pull_request" as const,
    number: 5,
  };
  type Worker = {
    fetch(request: Request, env: unknown): Promise<Response>;
    scheduled(event: unknown, env: unknown): Promise<void>;
    queue(batch: unknown, env: unknown): Promise<void>;
  };
  const outcomes: string[] = [];
  const log = console.log;
  console.log = (line: string) => {
    try {
      outcomes.push(JSON.parse(line).outcome);
    } catch {
      log(line);
    }
  };
  try {
    await cb({
      closeByMaintainer: () => {
        state = "closed";
      },
      loseNextReopenResponse: () => {
        loseReopenResponse = true;
      },
      pauseNextReopen: () => {
        let entered!: () => void;
        let release!: () => void;
        const arrival = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const resumed = new Promise<void>((resolve) => {
          release = resolve;
        });
        pauseReopen = async () => {
          entered();
          await resumed;
        };
        return { entered: arrival, release };
      },
      writes,
      comments,
      labels,
      review: () =>
        reviewItem(env as unknown as ReviewEnv, {
          kind: "review",
          deliveryId: "close-review",
          ...base,
        }),
      job: (kind, extra) =>
        ({
          kind,
          deliveryId: `${kind}-${outcomes.length}`,
          ...base,
          ...extra,
        }) as Job,
      deliver: async (body) => {
        await (worker as unknown as Worker).queue(
          {
            messages: [
              {
                body,
                ack() {},
                retry() {
                  throw new Error("appeal job was retried");
                },
              },
            ],
          },
          env,
        );
        return outcomes.at(-1) ?? "";
      },
      tick: async () => {
        sent.length = 0;
        await (worker as unknown as Worker).scheduled({}, env);
        return [...sent];
      },
      model: (category, confidence) => {
        verdict = { category, confidence };
      },
      sql: (q) => sqlite.query(q).all(),
      fetchWorker: (request) =>
        (worker as unknown as Worker).fetch(request, env),
    });
  } finally {
    console.log = log;
    globalThis.fetch = nativeFetch;
    server.stop(true);
    sqlite.close();
  }
}

const PENALTY =
  "SELECT category, debit_thirds, moderator_review, reversal FROM slopbot_penalties";
const APPEAL =
  "SELECT draft, escalation IS NOT NULL AS escalated, resolution, resolved_by FROM slopbot_appeals";
const day = 24 * 60 * 60 * 1000;

test("a spam close debits 3 thirds once; an accepted uphold draft reopens the item and reverses the debit once", async () => {
  await closedItem(async (run) => {
    expect(await run.review()).toBe("closed (spam)");
    expect(run.writes).toContain("PATCH /repos/SlopDotCash/asi/pulls/5");
    expect(run.sql(PENALTY)).toEqual([
      {
        category: "spam",
        debit_thirds: 3,
        moderator_review: 0,
        reversal: null,
      },
    ]);
    expect(run.comments.at(-1)).toContain("removes 3 thirds of a point");
    // A replayed review records nothing new.
    expect(await run.review()).toBe(
      "already reviewed at this revision and policy",
    );
    expect(run.sql(PENALTY)).toHaveLength(1);

    // The independent appeal review no longer finds spam.
    run.model("none", 0.95);
    expect(await run.deliver(run.job("appeal", { senderId: AUTHOR }))).toBe(
      "appeal drafted (uphold)",
    );
    expect(run.sql(APPEAL)).toEqual([
      { draft: "uphold", escalated: 0, resolution: null, resolved_by: null },
    ]);
    expect(run.comments.at(-1)).toContain(
      "Slopbot drafted this resolution: uphold",
    );
    // Another person cannot answer the draft.
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "accept", senderId: OUTSIDER }),
      ),
    ).toBe("only the appellant or a maintainer can answer the draft");

    expect(
      await run.deliver(
        run.job("appeal_command", { command: "accept", senderId: AUTHOR }),
      ),
    ).toBe("appeal upheld by the appellant");
    expect(
      run.writes.filter((w) => w === "PATCH /repos/SlopDotCash/asi/pulls/5"),
    ).toHaveLength(2);
    expect(run.labels).not.toContain("slopbot: spam");
    expect(run.sql(PENALTY)).toEqual([
      {
        category: "spam",
        debit_thirds: 3,
        moderator_review: 0,
        reversal: "appeal_upheld",
      },
    ]);

    // Replays, a later maintainer reopen and a re-review change nothing.
    const writes = run.writes.length;
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "accept", senderId: AUTHOR }),
      ),
    ).toBe("appeal already resolved");
    expect(
      await run.deliver(run.job("human_reopen", { senderId: MAINTAINER })),
    ).toBe("human_reopen");
    // A maintainer closes the item again. A later command from anyone does
    // not resume the completed decision or reopen the item.
    run.closeByMaintainer();
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "accept", senderId: OUTSIDER }),
      ),
    ).toBe("appeal already resolved");
    expect(run.writes).toHaveLength(writes);
    expect(run.sql(PENALTY)).toEqual([
      {
        category: "spam",
        debit_thirds: 3,
        moderator_review: 0,
        reversal: "appeal_upheld",
      },
    ]);
    expect(run.sql(APPEAL)).toEqual([
      {
        draft: "uphold",
        escalated: 0,
        resolution: "upheld",
        resolved_by: "appellant",
      },
    ]);
  });
});

test("a scam close escalates to a moderator; only a moderator decides, and a denial keeps the debit", async () => {
  await closedItem(async (run) => {
    run.model("scam", 0.97);
    expect(await run.review()).toBe("closed (scam)");
    expect(run.sql(PENALTY)).toEqual([
      {
        category: "scam",
        debit_thirds: 24,
        moderator_review: 1,
        reversal: null,
      },
    ]);
    expect(run.labels).toContain("slopbot: moderator");

    expect(await run.deliver(run.job("appeal", { senderId: AUTHOR }))).toBe(
      "appeal escalated: the finding is a confirmed-malicious result",
    );
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "accept", senderId: AUTHOR }),
      ),
    ).toBe("a Slop moderator decides this appeal");
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "uphold", senderId: MAINTAINER }),
      ),
    ).toBe("only a Slop moderator can decide an escalated appeal");
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "deny", senderId: MODERATOR }),
      ),
    ).toBe("appeal denied by the moderator");
    expect(run.sql(PENALTY)).toEqual([
      {
        category: "scam",
        debit_thirds: 24,
        moderator_review: 1,
        reversal: null,
      },
    ]);
    // A maintainer reopen still wins and reverses the debit once.
    expect(
      await run.deliver(run.job("human_reopen", { senderId: MAINTAINER })),
    ).toBe("human_reopen");
    expect(run.sql(PENALTY)).toEqual([
      {
        category: "scam",
        debit_thirds: 24,
        moderator_review: 1,
        reversal: "maintainer_reopen",
      },
    ]);
  });
});

test("a rejected draft escalates, and an appeal unresolved for 7 days escalates once", async () => {
  await closedItem(async (run) => {
    expect(await run.review()).toBe("closed (spam)");
    // The appeal review confirms the finding: the draft denies the appeal.
    expect(await run.deliver(run.job("appeal", { senderId: AUTHOR }))).toBe(
      "appeal drafted (deny)",
    );
    const start = Date.now();
    setSystemTime(new Date(start + 6 * day));
    expect(await run.tick()).toEqual([]);
    setSystemTime(new Date(start + 7 * day + 60_000));
    const due = await run.tick();
    expect(due.map((j) => j.kind)).toEqual(["appeal_due"]);
    expect(await run.deliver(due[0])).toBe(
      "appeal escalated: the appeal is unresolved 7 days after it opened",
    );
    expect(await run.tick()).toEqual([]);
    expect(run.labels).toContain("slopbot: moderator");
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "reject", senderId: MAINTAINER }),
      ),
    ).toBe("a Slop moderator decides this appeal");
  });
  await closedItem(async (run) => {
    expect(await run.review()).toBe("closed (spam)");
    await run.deliver(run.job("appeal", { senderId: AUTHOR }));
    expect(
      await run.deliver(
        run.job("appeal_command", { command: "reject", senderId: MAINTAINER }),
      ),
    ).toBe("appeal escalated: the maintainer rejected the draft");
    expect(run.sql(APPEAL)).toEqual([
      { draft: "deny", escalated: 1, resolution: null, resolved_by: null },
    ]);
  });
});

test("concurrent moderator decisions cannot deny an appeal after its uphold starts reopening the PR", async () => {
  await closedItem(async (run) => {
    run.model("scam", 0.97);
    await run.review();
    await run.deliver(run.job("appeal", { senderId: AUTHOR }));
    const pause = run.pauseNextReopen();
    const uphold = run.deliver(
      run.job("appeal_command", { command: "uphold", senderId: MODERATOR }),
    );
    await pause.entered;
    try {
      await run.deliver(
        run.job("appeal_command", { command: "deny", senderId: MODERATOR }),
      );
    } finally {
      pause.release();
      await uphold;
    }
    expect(run.sql("SELECT resolution FROM slopbot_appeals")).toEqual([
      { resolution: "upheld" },
    ]);
    expect(run.sql("SELECT reversal FROM slopbot_penalties")).toEqual([
      { reversal: "appeal_upheld" },
    ]);
    expect(
      run.comments.some((comment) => comment.includes("**Appeal denied**")),
    ).toBe(false);
  });
});

test("a retry after an uncertain reopen completes the recorded appeal decision", async () => {
  await closedItem(async (run) => {
    run.model("scam", 0.97);
    await run.review();
    await run.deliver(run.job("appeal", { senderId: AUTHOR }));
    run.loseNextReopenResponse();
    await expect(
      run.deliver(
        run.job("appeal_command", { command: "uphold", senderId: MODERATOR }),
      ),
    ).rejects.toThrow("appeal job was retried");
    expect(run.sql("SELECT resolution FROM slopbot_appeals")).toEqual([
      { resolution: "upheld" },
    ]);
    expect(run.sql("SELECT reversal FROM slopbot_penalties")).toEqual([
      { reversal: null },
    ]);
    await run.deliver(
      run.job("appeal_command", { command: "deny", senderId: MODERATOR }),
    );
    expect(run.sql("SELECT resolution FROM slopbot_appeals")).toEqual([
      { resolution: "upheld" },
    ]);
    expect(run.sql("SELECT reversal FROM slopbot_penalties")).toEqual([
      { reversal: "appeal_upheld" },
    ]);
    expect(run.labels).not.toContain("slopbot: scam");
    expect(run.comments.at(-1)).toContain("**Appeal upheld**");
  });
});

// PRD section 7: the recorded debit reaches the published Slop Score. The
// real worker records it, serves it on its public route, and the real
// producer binds it to the item and applies it to the leaderboard and to
// the monthly payment basis of that project.
const SLOP_AUTHOR: GitHubActor = {
  id: "U_author42",
  login: "author",
  avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
  url: "https://github.com/author",
  kind: "User",
};

function merged(
  repository: string,
  number: number,
  mergedAt: string,
  branch: string,
) {
  const url = `https://github.com/${repository}/pull/${number}`;
  const core = {
    id: `PR_${repository.replace(/\W/gu, "_")}_${number}`,
    number,
    title: `fix: accepted change ${number}`,
    url,
    body: "Fixes a defect.",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: mergedAt,
    mergedAt,
    author: SLOP_AUTHOR,
    additions: 4,
    deletions: 1,
  };
  return {
    outcome: {
      ...core,
      baseRefName: branch,
      commits: [
        { oid: String(number).repeat(40).slice(0, 40), author: SLOP_AUTHOR },
      ],
    },
    record: {
      ...core,
      lastEditedAt: null,
      editor: null,
      headRefOid: "d".repeat(40),
      isDraft: false,
      reviewDecision: "APPROVED",
      activeReviewRequestCount: 0,
      assignees: [],
      labels: [],
      files: [{ path: "src/fix.ts", additions: 4, deletions: 1 }],
      comments: [],
      reviews: [],
      closingIssueIds: [],
      changedFiles: 1,
      commitCount: 1,
    },
  };
}

function scoreInput(penaltyDebits: PenaltyDebitRecord[]): LeaderboardInput {
  const branch = (id: string) =>
    TARGET_REPOSITORIES.find((repository) => repository.id === id)
      ?.integrationBranch ?? "main";
  const pulls = [
    merged("elizaOS/asi", 1, "2026-09-20T00:00:00.000Z", branch("elizaOS/asi")),
    merged("elizaOS/asi", 2, "2026-10-10T00:00:00.000Z", branch("elizaOS/asi")),
    merged(
      "elizaOS/eliza",
      3,
      "2026-10-12T00:00:00.000Z",
      branch("elizaOS/eliza"),
    ),
  ];
  const at = "2026-10-20T12:00:00.000Z";
  return {
    generatedAt: at,
    windowFrom: "2026-09-15T12:00:00.000Z",
    windowTo: at,
    sourceUpdatedAt: "2026-10-12T00:00:00.000Z",
    source: {
      provider: "github-graphql",
      fetchedAt: at,
      cutoffAt: at,
      repositoryId: "R_fixture",
      repositories: TARGET_REPOSITORIES.map((repository, index) => ({
        id: repository.id,
        repositoryId: index === 0 ? "R_fixture" : `R_fixture_${index}`,
      })),
      requestCount: 1,
      searchSliceCount: 1,
      rateLimit: {
        cost: 1,
        limit: 5000,
        remaining: 4999,
        resetAt: "2026-10-20T13:00:00.000Z",
      },
      counts: {
        mergedPullRequests: pulls.length,
        detailedMergedPullRequests: pulls.length,
        closedIssues: 0,
        detailedClosedIssues: 0,
        resolvedIssues: 0,
        openIssues: 0,
        openPullRequests: 0,
      },
      verificationWindow: {
        days: 35,
        from: "2026-09-15T12:00:00.000Z",
        to: at,
      },
      evidenceVerification: {
        status: "complete",
        sourceCount: 0,
        artifactCount: 0,
        maxSources: 64,
        maxArtifacts: 64,
      },
    },
    mergedPullRequestOutcomes: pulls.map((pull) => pull.outcome),
    mergedPullRequests: pulls.map((pull) => pull.record),
    detailEligibleMergedPullRequestIds: pulls.map((pull) => pull.outcome.id),
    closedIssueCount: 0,
    resolvedIssues: [],
    openIssues: [],
    openPullRequests: [],
    verificationWindowFrom: "2026-09-15T12:00:00.000Z",
    verifiedEvidence: [],
    penaltyDebits,
  };
}

test("a recorded debit lowers only its project month on the published Slop Score, never below zero, and its reversal restores it", async () => {
  setSystemTime(new Date("2026-10-20T11:58:00.000Z"));
  await closedItem(async (run) => {
    const project = findProject("asi");
    if (!project) throw new Error("fixture project missing");
    const repositoryId = Number(project.authority.repositoryId);
    // The published route is the only source the producer reads.
    const transport = (url: URL, init: RequestInit) => {
      expect(url.origin).toBe("https://slopbot.slop.cash");
      return run.fetchWorker(new Request(url, init));
    };
    let lookups = 0;
    const graphql = async (
      _query: string,
      variables: Record<string, unknown>,
    ) => {
      lookups += 1;
      expect(variables.ids).toEqual(["PR_local"]);
      return {
        nodes: [
          {
            __typename: "PullRequest",
            id: "PR_local",
            number: 5,
            title: "Followers",
            url: "https://github.com/elizaOS/asi/pull/5",
            repository: {
              databaseId: repositoryId,
              nameWithOwner: "elizaOS/asi",
            },
            author: { __typename: "User", databaseId: AUTHOR, ...SLOP_AUTHOR },
          },
        ],
      };
    };
    const score = async () => {
      const snapshot = createLeaderboardSnapshot(
        scoreInput(await loadPenaltyDebits(graphql, transport)),
      );
      const leader = (projectId: string, cycle: string) =>
        createPaymentProjectView(snapshot, projectId, cycle).leaders.find(
          (entry) => entry.actor.id === SLOP_AUTHOR.id,
        );
      const month = (projectId: string, cycle: string) =>
        leader(projectId, cycle)?.scoreThirds;
      return {
        total: snapshot.leaders.find(
          (leader) => leader.actor.id === SLOP_AUTHOR.id,
        )?.scoreThirds,
        debits: snapshot.ledger
          .filter((event) => event.category === "penalty-debit")
          .map((event) => ({
            id: event.id,
            scoreThirds: event.scoreThirds,
            penalty: event.penalty,
          })),
        asiSeptember: month("asi", "2026-09"),
        asiOctober: month("asi", "2026-10"),
        elizaOctober: month("eliza", "2026-10"),
        // The monthly payment weight follows the debited score.
        asiOctoberWeight: leader("asi", "2026-10")?.adjustedWeight,
      };
    };
    // Before any close: September micro 1, October small 3 in each project.
    expect(await score()).toEqual({
      total: 7,
      debits: [],
      asiSeptember: 1,
      asiOctober: 3,
      elizaOctober: 3,
      asiOctoberWeight: 30_000,
    });
    expect(lookups).toBe(0);

    run.model("scam", 0.97);
    expect(await run.review()).toBe("closed (scam)");
    // The 24-third debit takes only the 3 thirds that asi earned in
    // October: that month stops at zero; September and eliza keep theirs.
    expect(await score()).toEqual({
      total: 4,
      debits: [
        {
          id: "penalty:PR_local",
          scoreThirds: -3,
          penalty: {
            category: "scam",
            tableVersion: "slopbot-penalties-v1",
            debitThirds: 24,
            appliedThirds: 3,
            period: "2026-10",
          },
        },
      ],
      asiSeptember: 1,
      asiOctober: 0,
      elizaOctober: 3,
      asiOctoberWeight: 0,
    });
    // A replayed review adds no second debit.
    await run.review();
    expect((await score()).debits).toHaveLength(1);

    // A maintainer reopen reverses the debit once; the next publication
    // restores the month.
    expect(
      await run.deliver(run.job("human_reopen", { senderId: MAINTAINER })),
    ).toBe("human_reopen");
    expect(await score()).toEqual({
      total: 7,
      debits: [],
      asiSeptember: 1,
      asiOctober: 3,
      elizaOctober: 3,
      asiOctoberWeight: 30_000,
    });
  });
});

test("the penalty route serves identifiers and outcomes only, and the producer refuses a changed author", async () => {
  setSystemTime(new Date("2026-10-20T11:58:00.000Z"));
  await closedItem(async (run) => {
    expect(await run.review()).toBe("closed (spam)");
    const page = await run.fetchWorker(
      new Request("https://slopbot.slop.cash/v1/penalties?after="),
    );
    expect(page.headers.get("cache-control")).toBe("no-store");
    const body = await page.json();
    expect(Object.keys(body.records[0]).sort()).toEqual([
      "authorGithubId",
      "category",
      "debitThirds",
      "itemNodeId",
      "period",
      "projectId",
      "recordedAt",
      "repositoryId",
      "reversal",
      "reversedAt",
      "tableVersion",
    ]);
    expect(body).toMatchObject({
      schemaVersion: "slop-penalty-history:v1",
      nextAfter: null,
      records: [{ authorGithubId: "42", category: "spam", debitThirds: 3 }],
    });
    expect(
      (
        await run.fetchWorker(
          new Request("https://slopbot.slop.cash/v1/penalties?after=%27"),
        )
      ).status,
    ).toBe(400);
    const project = findProject("asi");
    await expect(
      loadPenaltyDebits(
        async () => ({
          nodes: [
            {
              __typename: "PullRequest",
              id: "PR_local",
              number: 5,
              title: "Followers",
              url: "https://github.com/elizaOS/asi/pull/5",
              repository: {
                databaseId: Number(project?.authority.repositoryId),
                nameWithOwner: "elizaOS/asi",
              },
              author: { __typename: "User", databaseId: 7, ...SLOP_AUTHOR },
            },
          ],
        }),
        (url, init) => run.fetchWorker(new Request(url, init)),
      ),
    ).rejects.toThrow("does not match its recorded item or author");
    // A release that runs before Slopbot serves this route keeps the last
    // published snapshot (owner decision D2) instead of assuming no debits.
    await expect(
      loadPenaltyDebits(
        async () => ({ nodes: [] }),
        async () => new Response("not found", { status: 404 }),
      ),
    ).rejects.toBeInstanceOf(ValueFeedUnavailableError);
  });
});
