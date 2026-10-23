# Private security bounty cases

PRD SEC-01 to SEC-18 and MVP-13. Program terms are public; cases are not.

## Program terms

A project opts in with the optional `securityBounty` section of its D1
manifest (`src/lib/security-bounty.mjs`). An application may include it only
as `pending-approval` with `pledged` funding. Admins open, pause or close the
program by appending a manifest revision on `/admin`. A program cannot be
removed, because its approvers govern restricted case access after closure.

- `amount.grossMinor` is integer minor units. It must be divisible by four, so
  the 75/25 researcher/Slop split is exact. Shares are derived, never stored.
- `rewardMode: "bounty-only"` requires a `$0` monthly pool with payments
  disabled. `separate` keeps the project's ordinary rewards.
- `status: "open"` requires `funding.state: "verified-available"` with an
  evidence reference. A pledge never opens paid capacity.
- `approvers.dispute` must not include a technical or financial approver.
- `intake.repository` must be one of the project repositories.

`/projects/:id/terms.json` and `/projects/:id/security` publish these terms.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `GET /api/v1/security-programs/:id/intake` | public, edge cached 30 s | GitHub private vulnerability reporting readiness: `ready`, `disabled`, `forbidden` or `unavailable`. Only `ready` returns the GitHub handoff URL. `automatic` is `ready`, `app-not-installed`, `unavailable` or `off` |
| `GET /api/v1/security-cases` | session | Cases the caller can see now, shaped per role |
| `POST /api/v1/security-cases` | session | `claim`: a reporter links a GitHub advisory ID. `record`: a technical approver records a verified advisory with GitHub's receipt time |
| `GET /api/v1/security-cases/:id` | session and role | One case; logs the read |
| `POST /api/v1/security-cases/:id/actions` | session and role | One human decision with `expectedRevision` and `idempotencyKey` |
| `GET /api/v1/security-submissions` | session | The caller's own automatic submissions: state, attempt, GHSA, GitHub time, failure code, case id |
| `POST /api/v1/security-submissions` | session | Creates (or replays) a `slop` draft or a `direct` verification and returns the intake App authorization URL |
| `GET /api/v1/security-submissions/authorize/callback` | GitHub redirect | PKCE exchange, `/user` identity binding, grant cookie |
| `POST /api/v1/security-submissions/:id/{authorize,send,reconcile,verify}` | reporter only | Reauthorize, send privately, reconcile an uncertain send, verify a direct report |

A caller without a role gets the same 404 as for a missing case. Writes need
this site's `Origin` and a JSON content type. Responses are `private,
no-store` and `noindex`. Errors never log case data.

## Automatic private intake

PRD section 8 ("Private reporting is automatic"), SEC-07, SEC-10, SEC-17.
Every `security-submissions` route returns 404 unless
`SLOP_PRIVATE_INTAKE_MODE=on` and all intake App secrets are set
(`GITHUB_INTAKE_APP_CLIENT_ID`, `GITHUB_INTAKE_APP_CLIENT_SECRET`,
`GITHUB_INTAKE_APP_ID`, `GITHUB_INTAKE_APP_PRIVATE_KEY`,
`SLOP_INTAKE_GRANT_KEY`). The dedicated intake GitHub App (repository
security advisories read and write, metadata read, no webhooks) still needs
owner approval in the PRD and a maintainer installation on each program
repository. Until then intake stays off and the manual flow below applies.

- Authorization: a per-submission PKCE consent for the intake App. The
  callback checks that `/user` is the account that began the consent and
  stores the user token only in an AES-GCM encrypted HttpOnly
  `__Secure-slop_intake_grant` cookie (path `/api/v1/security-submissions`,
  2 hours) bound to the submission and the site session. No access or
  refresh token is stored in D1. GitHub records the reporter as the author.
- `security_submissions` (migration 0059) holds no report content. States:
  `draft`, `submitting`, `uncertain`, `submitted`, `receipt-verified`,
  `failed`, `abandoned`. Every transition is a revision compare-and-set
  with an insert-only event in the same batch. `submitting` commits before
  GitHub is called; a lost answer, a 5xx, a malformed 201 or a 201 naming
  another author is `uncertain`.
- Marker: the description gets one line, `Report reference: <32 hex>`, a
  random value per submission. It names neither the submission nor Slop,
  because it stays in the text if the advisory is published
  (OPEN_QUESTION 9); the consent notice says so.
- Reconcile before retry: an uncertain send lists the reporter's advisories
  since the first attempt with their own token and matches the marker line
  and author. Only a complete listing without a match, taken at least
  5 minutes after the attempt began, reopens the draft for another send;
  an earlier empty listing or a listing error stays `uncertain`. Several
  matches adopt the earliest and show the rest to the technical approvers
  only. A resend that GitHub accepts lists again and adopts an earlier copy
  that landed late, recording the accepted one as a duplicate. A
  `submitting` row older than 60 seconds becomes `uncertain` and is never
  resent. A `submitted` row Slop cannot verify within 24 hours fails as
  `unverifiable`; it is never resent and no longer blocks a new report.
- Receipt: GitHub's advisory must name the program repository and the
  reporter as author (a reporter credit never counts), carry the marker
  (Slop origin) and have a past `created_at`. A direct report must also be
  a private vulnerability report (GitHub's `submission` object) in
  `triage`, `draft` or `published`; anything else fails as
  `not-private-report` and uses the manual claim path. The verified case,
  its `submit` or `submit-direct` event (the reporter's own action; the
  detail records `verifiedBy: "github"`), routing fields, the access log and the inbox rows commit with the
  submission transition. The receipt time is GitHub's `created_at`
  (`receivedAtSource: "github-verified"`), the verifier is the sentinel
  `github`, and `receipt_evidence_digest` stores the SHA-256 of the
  advisory fields GitHub returned.
- Direct reports: "Already reported on GitHub? Verify it" runs the same
  receipt check on a GHSA the reporter filed themselves; GitHub's original
  `created_at` is kept. Without the App installed, the manual claim and
  verify-link path below remains the fallback.
- Analysis: `report-analysis.ts` recommends only, from GitHub's structured
  severity and CVSS fields. Its result is in the restricted event detail
  only; the case's owner, neutral next action and due time (the published
  acknowledgement target) do not depend on it, because the reporter sees
  them. It never sets severity, receipt, award or disclosure. No model sees
  report content; none is approved.

## Roles

Roles are computed on every request from the session and the current project
revision, so a revision or a revoked session removes access at once.

- Reporter: their own cases, never another report, root cause or triager.
- Any registered user may report; project membership is not required.
- Technical approver (security maintainer): every case of the project.
- Triager: only assigned cases; triage, next action and remediation.
- Financial approver: only cases with a reserved, exhausted or approved
  award, and only award and payment fields.
- Dispute reviewer: only cases with an appeal or a related-party award
  review.
- Platform admins, sponsors and the public: nothing.

A reporter never acts on their own case. The financial approver cannot be the
technical decider. The technical decider cannot decide the appeal or the
related-party review, and the related-party reviewer cannot decide an appeal
of that review, or review the same case again once an appeal has returned it
for a new decision.

## States

Migration `0026_private_security_cases.sql` keeps independent receipt,
remediation, award, payment and disclosure states. A claim is not a receipt
until a technical approver verifies it; verification freezes the receipt
time, the project revision in force then, and its gross amount and split.
Slop does not fetch the advisory, so the receipt time is the time the
approver reads on GitHub and enters by hand: a human-attested time. Every
case response says so with `receivedAtSource: "maintainer-attested"`, and the
`record` and `verify-link` events store the same value beside the time.

A rejected link stays as history. The reporter can link the advisory again,
or a technical approver can record it, and that new case is verified
normally. A `record` that finds an open claim from the same reporter returns
`409 claim_pending`: verify or reject that claim instead. A `record` replays
only the exact request that created the verified case.

Triager assignment and revocation commit only together with their audit
event at the next case revision. A stale request changes no membership.
Triggers keep the frozen receipt, events, reservations, membership history
and the access log append-only.

A confirmed critical finding with verified potential or actual loss on an
in-scope asset reserves its gross amount once per root cause within the
current capacity. Without capacity the award is `capacity-exhausted`; the
finding stays confirmed. A reserved or approved award cannot be redecided.

Capacity is read from the current project revision. When an admin raises
`capacity.awards` by revision, a financial approver uses `reserve-award` on
an exhausted case. The earliest received exhausted case is funded first
(`409 earlier_receipt_waiting` otherwise). If no capacity is free, the request
returns `409 capacity_exhausted` and writes nothing. Every reserving path
(`decide`, related-party `approve`, and `reserve-award`) uses one guard in the
reservation insert: while an earlier confirmed case waits for capacity or
for its related-party review, a later decision or approval reserves nothing
and its award is `capacity-exhausted`, so it waits its turn.

A reporter may appeal an exhausted award: the shortage is a financial
exception, not a reason to relabel the finding (SEC-12). The appeal carries the
receipt into `disputed`, and that case still holds its place in the funding
order, so no later report can reserve its root cause or its capacity while an
independent reviewer resolves it. `uphold` restores the confirmed receipt
unchanged; `return` sends the finding back to a new decision, which reserves as
soon as capacity exists. Neither outcome erases or duplicates an award, and a
reserved or approved award is still never redecided.

The technical decision records `relatedParty`. The decider declares it, and a
reporter who is a program approver or the sponsor account is always related.
An eligible related-party award stays `pending` with no reservation until a
dispute reviewer records `decide-related-party`. `approve` reserves within
capacity like any other award; `refuse` makes the award `ineligible`, which
the reporter can appeal to a different reviewer. A pending review holds its
root cause: a later report of the same root cause gets `409
root_cause_reserved` and is recorded as a duplicate. Once a case is related,
it stays related. A redecision after a returned appeal needs a new review,
and the earlier reviewer stays recorded.

## Disclosure approval records

A disclosure decision records its private human-approval evidence reference.
Approving redacted text also binds the exact content SHA-256. Recording disclosure
requires the latest disclosure decision to approve those same bytes, and retains
that approval's case revision. Changed bytes need a new approval. Any approved
embargo change is explicit in the immutable event; omission means no change.
These records do not publish content or schedule disclosure. Reporter recognition
consent stays separate. Older events remain unchanged and cannot authorize a new
disclosure without an exact content approval.

## Private settlement

The 22 October 2026 product decision uses the existing escrow rails with a
75% reporter share and 25% Slop share. Migration
`0057_private_security_payments.sql` separates settlement intents, payment
records, attempts and finalized vault snapshots from ordinary payments.
Canonical wallet possession and binding authorizations remain shared.

An admin must record a reviewed `securityBounty.settlement` policy with a
separate vault and `feeBasisPoints: 2500`. The vault must not appear in
any other payment program. USDC awards require a matching reviewed USDC rail;
USD awards cannot be converted implicitly. The reporter accepts the selected
rail's public chain visibility before a financial approver prepares an
immutable unsigned commitment. Onchain records expose actor numbers, addresses,
times and amounts. They contain a random source commitment, never report data.

The owner submits the unsigned commitment outside Slop. The private worker
uses the existing finalized-event verifier and recovery engine, with the
25% fee policy and the exact approved private intent. Public payment queries,
notifications and aggregates never use these tables. A lost response is
uncertain until verified chain evidence resolves it. No action can manually
mark an award paid. Missing wallets retain their award; the canonical wallet
proof and delay apply when a wallet is added or changed.

Generate the reviewed private deployment inventory with
`bun scripts/prepare-payment-deployments.ts testnet <network> --security-bounty`
and the existing stack generator with `--scope security-bounty`.
Production retains the existing attester-only policy; this change does not
authorize a Slop signer or mainnet dispatch. Test stacks use isolated databases.
Without an approved and verified matching vault, the case shows
`rail-unavailable` and cannot prepare settlement.

Solana wallet co-signing uses the existing authenticated
`/api/v1/payments/wallets/solana-bind/prepare` and `complete` endpoints.
The lookup resolves the signed-in reporter's private obligation and records
an audited access. Private binding requests use the separate
`SECURITY_SOLANA_IDENTITY_ATTESTER` service binding; they never fall back to
the ordinary attester. Missing service configuration fails closed.

## Remaining hosted acceptance

- Email: the restricted verified-destination pilot is implemented in
  `workers/notify/security.ts`; deployment and inbox delivery remain launch
  gates. See `workers/notify/README.md`. Every case inbox insert also queues
  one private outbox row in the same transaction. Only current case roles
  with operator-verified destinations receive generic notices. An email
  never contains a case identifier, amount, project or advisory. The inbox
  action **Acknowledge** records the recipient's authenticated response;
  **Mark read** is a separate state and never acknowledges a notice.
- On the manual path GitHub advisory content is never fetched; maintainers
  verify claims by hand on GitHub. Automatic intake reads only the
  reporter's own advisory with the reporter's token and keeps only its
  digest. Its GitHub behaviour (user tokens on `/reports`, error shapes,
  listing visibility) is not yet qualified on a real repository.
