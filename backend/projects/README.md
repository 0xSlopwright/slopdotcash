# Project registry API

The D1 database `slop-private` is the only project inventory. Projects are
added on slop.cash, not by pull request. This module serves the registry,
takes applications, and lets admins review them. It runs in the Pages
Function `functions/api/v1/[[path]].ts` before the payments, points, Slopbot
and private trace APIs.

## Tables

Migration `0019_project_registry.sql` creates:

- `project_applications`: submitted manifests, applicant GitHub identity,
  review status, decision, and admin email outcome. One pending application
  per project id and per repository.
- `project_revisions`: the append-only manifest history. Triggers refuse
  update and delete.
- `projects`: the current pointer to the newest revision. Triggers require a
  matching appended revision for every insert and update, and refuse delete.
- `project_repositories`: makes each repository unique across the registry.

The registry starts empty. Projects listed before it were removed; their ids
and repository ids survive only in `src/lib/legacy-projects.json` so contributor
points and profiles still validate.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `GET /api/v1/projects` | public, edge cached | Current manifests |
| `GET /api/v1/projects/:id` | public, edge cached | One current manifest, revision and digest |
| `GET /api/v1/project-revisions` | public, edge cached | Full revision history with SHA-256 digests |
| `GET /api/v1/project-github/owned-repositories` | session | The signed-in maintainer's public repositories |
| `GET /api/v1/project-github/repositories/:owner/:name` | session | Public repository facts for `/projects/new` |
| `GET /api/v1/project-session` | public | GitHub identity and admin flag, or `null` when signed out |
| `POST /api/v1/project-applications` | session | Submits an application and emails the admins |
| `GET /api/v1/project-applications/mine` | session | The applicant's own applications |
| `GET /api/v1/admin/project-applications?status=` | admin | Review queue |
| `POST /api/v1/admin/project-applications/:id/approve` | admin | Lists the project as paused (optional `reason`) |
| `POST /api/v1/admin/project-applications/:id/reject` | admin | Rejects with a required `reason` |
| `GET /api/v1/admin/projects` | admin | Registry with revisions |
| `PUT /api/v1/admin/projects/:id/manifest` | admin | Appends a revision (`manifest`, `expectedRevision`, `reason`) |

Deeper `/api/v1/projects/:id/...` paths belong to the private trace API.

The site catch-all Function (`functions/[[path]].ts`, `skill-publication.ts`)
serves these public artifacts from the current D1 revision:

| Path | Content |
|---|---|
| `/.well-known/slop/projects.json` | Repository-to-project routing for every project that publishes skills |
| `/projects/:id/terms.json` | Steward, authority and terms of the current revision |
| `/projects/:id/SKILL.md` (alias `skill.md`) | Generated contributor skill |
| `/projects/:id/references/project.md` | Project facts the skill was generated from |
| `/projects/:id/review/SKILL.md` (alias `review-skill.md`) | Generated reviewer skill |
| `/projects/:id/skill-manifest.json`, `review-skill-manifest.json` | Digest, template commit, revision and archive routing |
| `/projects/:id/downloads/<skill>.skill` and `.skill.sha256` | Deterministic skill archive and checksum |

## Caching

Public reads and artifacts use the Workers Cache API with a 30 second TTL
(`edge-cache.ts`). An approval or a revision deletes every key of that project
in the writing colo; other colos expire within the TTL. Admin and session
routes are never cached. Page views never read GitHub or a chain.

## Generated skills

Each project's contributor and reviewer skills are rendered by
`src/lib/project-skill-render.mjs` from one template pair
(`skills/contribute-to-project/`, `skills/review-project-contributions/`, and
the shared `scripts/skill-kit/` files) and the manifest's maintainer-authored
`skillContent`: scope, contribution guide, supported tasks, required tests,
review expectations, security contact, closure policy and notes. The build
publishes the template bytes and their SHA-256 digests at
`/skill-templates/index.json` with the source commit; the Function refuses a
file whose digest differs. Rendering is deterministic. The skill digest binds
the template commit, the project id, the revision, the manifest SHA-256, the
public origin and every rendered file, and `run-receipt.mjs disclose` writes it
into the attribution footer. `scripts/render-project-skill.mjs` reproduces the
bytes from a checkout and the public revision history.

## Reward asset

`rewardAsset` names one network (`base`, `solana`, `robinhood`, `ethereum`)
and either that network's stablecoin or one ERC-20 or classic SPL token. The
API reads a token's decimals (and an EVM symbol) once over RPC when the asset
is submitted or changed (`token-metadata.ts`), stores them in the manifest, and
keeps them on later revisions of the same asset. `REWARD_RPC_<NETWORK>` Pages
variables may replace the public RPC endpoints. A token, or a network outside
the Base and Solana USDC rail without a reviewed escrow, keeps payments
disabled; the asset is display metadata until a reviewed payout path exists.

## GitHub lookups

`/projects/new` reads repository facts through the same-origin
`project-github` routes, which need a site session. The server reads public
GitHub data, with the optional `GITHUB_LOOKUP_TOKEN` secret for a higher rate
limit, and caches each answer for five minutes. The browser never calls
`api.github.com` for setup.

## Trust rules

- A session is the site sign-in cookie that `/login` creates through the
  identity Worker (`backend/points/handler.ts`). The registry mints no session
  of its own.
- Writes must carry this site's `Origin` and a JSON content type, so a
  cross-site form cannot submit one.
- Admins are the GitHub actor IDs in the `ADMIN_GITHUB_IDS` Pages variable.
  Admin status is checked on every request, never stored.
- An application must be a paused, unverified, unfunded community project with
  payments disabled, no funding addresses or commitments, no escrow deployment,
  and no root skill publication. Authority, terms, money, listing tier, and
  activation are added only by admin revisions.
- Every revision must pass `assertProjectPolicyTransition`, the review-budget
  rule, and the registry uniqueness checks. A revision that makes a project
  active requires complete `skillContent`. Root skill publication is retired.
- A stale `expectedRevision` fails with HTTP 409 instead of overwriting.
- The application is stored before the admin email. A failed or missing
  notifier is recorded as `adminNotification: "failed"` and shown in the admin
  queue.

## Publication

The site reads the registry from `GET /api/v1/projects` when a page loads
(`src/main.tsx`), so an approved project or a saved revision appears without a
build. `bun run projects:sync` still snapshots the registry for build-time
ingestion, which decides which active repositories to collect, and
`bun run projects:check` proves the committed snapshot is canonical and that
every active project carries skill content.
