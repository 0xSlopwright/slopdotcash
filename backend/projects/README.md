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
| `GET /api/v1/projects` | public | Current manifests |
| `GET /api/v1/project-revisions` | public | Full revision history with SHA-256 digests |
| `GET /api/v1/project-session` | public | GitHub identity and admin flag, or `null` when signed out |
| `POST /api/v1/project-applications` | session | Submits an application and emails the admins |
| `GET /api/v1/project-applications/mine` | session | The applicant's own applications |
| `GET /api/v1/admin/project-applications?status=` | admin | Review queue |
| `POST /api/v1/admin/project-applications/:id/approve` | admin | Lists the project as paused (optional `reason`) |
| `POST /api/v1/admin/project-applications/:id/reject` | admin | Rejects with a required `reason` |
| `GET /api/v1/admin/projects` | admin | Registry with revisions |
| `PUT /api/v1/admin/projects/:id/manifest` | admin | Appends a revision (`manifest`, `expectedRevision`, `reason`) |

Deeper `/api/v1/projects/:id/...` paths belong to the private trace API.

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
  active requires both skill folders on `SlopDotCash/slopdotcash`
  `development`.
- A stale `expectedRevision` fails with HTTP 409 instead of overwriting.
- The application is stored before the admin email. A failed or missing
  notifier is recorded as `adminNotification: "failed"` and shown in the admin
  queue.

## Publication

The public site is a static build. Trusted CI runs `bun run projects:sync`
when the repository variable `SLOP_PROJECT_REGISTRY_SOURCE` is `d1`, so a
registry change appears after the next build. Staging builds read
`https://staging.slop.cash`. `bun run projects:check` proves the committed
snapshot is canonical and that every active project names skills in this tree.
A paused project without skill folders is listed but publishes no skill.
