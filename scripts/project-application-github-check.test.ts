// The GitHub check of a project application through the production Pages
// Function: every repository and alias in the manifest is read from GitHub,
// not only the first repository.
import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { onRequest } from "../functions/api/v1/[[path]]";
import { applicationManifest } from "../tests/project-application-manifest";
import { sqliteD1 } from "../tests/sqlite-d1";
import { sha256Hex } from "../workers/identity/crypto";

const ORIGIN = "https://slop.cash";
const API = "https://api.github.com";
const SESSION = "t".repeat(48);

const OWNER = {
  id: 987654321,
  node_id: "U_example",
  login: "example",
  type: "User",
};
const repositories: Record<string, unknown> = {
  "example/open-registry": {
    id: 123456789,
    node_id: "R_example",
    full_name: "example/open-registry",
    private: false,
    owner: OWNER,
  },
  "example/registry-docs": {
    id: 223456789,
    node_id: "R_docs",
    full_name: "example/registry-docs",
    private: false,
    owner: OWNER,
  },
  "partner-lab/shared-models": {
    id: 323456789,
    node_id: "R_partner",
    full_name: "partner-lab/shared-models",
    private: false,
    owner: {
      id: 777000111,
      node_id: "O_partner_lab",
      login: "partner-lab",
      type: "Organization",
    },
  },
  "someone-else/their-repo": {
    id: 555000111,
    node_id: "R_other",
    full_name: "someone-else/their-repo",
    private: false,
    owner: {
      id: 444000111,
      node_id: "U_someone_else",
      login: "someone-else",
      type: "User",
    },
  },
};
// GitHub answers a former name with the renamed repository.
repositories["example/old-registry-name"] =
  repositories["example/open-registry"];

const realFetch = globalThis.fetch;
const lookups: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  lookups.length = 0;
});

async function submit(manifest: unknown) {
  const { db, sqlite } = sqliteD1(
    readdirSync(resolve(import.meta.dir, "..", "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort(),
  );
  sqlite.exec(
    `INSERT INTO points_members (actor_id, github_id, login, joined_at, public)
     VALUES ('act_1', '987654321', 'example', '2026-10-01T00:00:00.000Z', 0)`,
  );
  sqlite
    .prepare(
      "INSERT INTO points_sessions (token_hash, actor_id, expires_at) VALUES (?, 'act_1', '2099-01-01T00:00:00.000Z')",
    )
    .run(await sha256Hex(SESSION));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    lookups.push(url);
    if (url === `${API}/orgs/partner-lab/public_members/example`)
      return new Response(null, { status: 204 });
    const path = url.startsWith(`${API}/repos/`)
      ? url.slice(`${API}/repos/`.length)
      : "";
    return repositories[path]
      ? Response.json(repositories[path])
      : Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  const response = await onRequest({
    request: new Request(`${ORIGIN}/api/v1/project-applications`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: `__Host-slop_points=${SESSION}`,
      },
      body: JSON.stringify({ manifest }),
    }),
    env: { SLOP_DB: db, ADMIN_GITHUB_IDS: "900000001" } as never,
  });
  const body = (await response.json()) as {
    application?: { githubCheck: string };
    error?: string;
    message?: string;
  };
  return { status: response.status, body };
}

/** The `/projects/new` manifest for a user repository, plus `repositories`. */
function manifestWith(...extra: Record<string, unknown>[]) {
  const base = applicationManifest("open-registry", "example/open-registry");
  const [first] = base.repositories as Record<string, unknown>[];
  const steward = base.steward as { github: Record<string, unknown> };
  return {
    ...base,
    steward: {
      ...steward,
      github: {
        ...steward.github,
        nodeId: "U_example",
        type: "User",
        profileUrl: "https://github.com/example",
      },
    },
    repositories: [{ ...first, ...extra[0] }, ...extra.slice(1)],
  };
}

function repository(id: string) {
  return {
    id,
    displayName: id,
    githubUrl: `https://github.com/${id}`,
    description: "Another repository of the same project.",
    integrationBranch: "main",
  };
}

test("an application the applicant controls in every repository is proven", async () => {
  const { status, body } = await submit(
    manifestWith(
      {},
      repository("example/registry-docs"),
      repository("partner-lab/shared-models"),
    ),
  );
  expect(status).toBe(201);
  expect(body.application?.githubCheck).toBe(
    "Proven: @example owns example/open-registry",
  );
  expect(lookups).toContain(`${API}/repos/partner-lab/shared-models`);
});

test("a second repository the applicant does not control is not proven", async () => {
  const { status, body } = await submit(
    manifestWith({}, repository("someone-else/their-repo")),
  );
  expect(status).toBe(201);
  expect(body.application?.githubCheck).toBe(
    "Not proven: @example does not own someone-else/their-repo",
  );
});

test("a second repository GitHub does not have is refused", async () => {
  const { status, body } = await submit(
    manifestWith({}, repository("someone-else/missing-repo")),
  );
  expect(status).toBe(422);
  expect(body).toMatchObject({
    error: "invalid_manifest",
    message: "GitHub has no public repository named someone-else/missing-repo",
  });
});

test("an alias must lead to the repository it names", async () => {
  const former = await submit(
    manifestWith({ aliases: ["example/old-registry-name"] }),
  );
  expect(former.status).toBe(201);
  expect(former.body.application?.githubCheck).toBe(
    "Proven: @example owns example/open-registry",
  );

  const other = await submit(
    manifestWith({ aliases: ["someone-else/their-repo"] }),
  );
  expect(other.status).toBe(422);
  expect(other.body).toMatchObject({
    error: "invalid_manifest",
    message:
      "Alias someone-else/their-repo is not a name of example/open-registry on GitHub",
  });

  const missing = await submit(
    manifestWith(
      {},
      {
        ...repository("example/registry-docs"),
        aliases: ["someone-else/missing-repo"],
      },
    ),
  );
  expect(missing.status).toBe(422);
  expect(missing.body.message).toBe(
    "GitHub has no public repository named someone-else/missing-repo",
  );
});

test("an application names at most 5 repositories and aliases", async () => {
  const docs = repositories["example/registry-docs"];
  for (const name of ["docs-old-1", "docs-old-2", "docs-old-3"])
    repositories[`example/${name}`] = docs;
  const five = manifestWith(
    { aliases: ["example/old-registry-name"] },
    {
      ...repository("example/registry-docs"),
      aliases: ["example/docs-old-1", "example/docs-old-2"],
    },
  );
  const accepted = await submit(five);
  expect(accepted.status).toBe(201);
  expect(lookups.filter((url) => url.startsWith(`${API}/repos/`))).toHaveLength(
    5,
  );

  lookups.length = 0;
  const [first, second] = five.repositories as Record<string, unknown>[];
  const six = {
    ...five,
    repositories: [
      first,
      {
        ...second,
        aliases: [...(second.aliases as string[]), "example/docs-old-3"],
      },
    ],
  };
  const refused = await submit(six);
  expect(refused.status).toBe(422);
  expect(refused.body).toMatchObject({
    error: "invalid_manifest",
    message: "An application may name at most 5 repositories and aliases",
  });
  expect(lookups).toEqual([]);
});
