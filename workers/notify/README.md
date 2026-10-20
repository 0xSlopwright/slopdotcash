# Slop notify Worker

`slop-notify` sends one plain-text email to each Slop admin when a person
submits a new project application. It exists because Pages Functions cannot use
`send_email` bindings.

## Route

The Worker has no public route and `workers_dev` is off. The caller is a
service binding named `SLOP_NOTIFY` on the production Pages app. That caller
is the authenticated project-application submit path in
`backend/projects/handler.ts`. Cloudflare refuses to publish Pages with a
binding to a Worker that does not exist. The protected production release
39373511823 deployed this Worker before the binding was added to
`wrangler.toml`. Without the binding, the
application is saved and records `adminNotification: "failed"`. The only accepted route
is:

```http
POST https://notify.internal/v1/project-applications
Content-Type: application/json

{
  "applicationId": "app_0123456789abcdef",
  "projectId": "example-project",
  "projectName": "Example Project",
  "repository": "example-org/example-repo",
  "applicantLogin": "octo-cat",
  "submittedAt": "2026-10-11T12:00:00.000Z",
  "reviewUrl": "https://slop.cash/admin/applications/app_0123456789abcdef"
}
```

The body must be JSON of at most 8 KiB with exactly these string keys. The
handler rejects any other host or path with 404, any other method with 405, and
any invalid body with 400 `{"error":"invalid_request"}`. It sends no email for
a rejected request.

Results:

| Status | Body                                         | Meaning                       |
| ------ | -------------------------------------------- | ----------------------------- |
| 202    | `{"status":"sent","recipients":<n>}`         | Every admin email was handed to Cloudflare. |
| 502    | `{"error":"delivery_failed","sent":<n>}`     | At least one send failed; `n` were sent. |
| 500    | `{"error":"service_misconfigured"}`          | The sender or admin list is invalid; nothing was sent. |

A 202 means Cloudflare accepted the messages. It does not prove inbox delivery.

## Recipients

The admin addresses are not in the repository. Operators set them as the
Worker secret `ADMIN_EMAILS`, a comma-separated list of 1 to 10 unique
addresses:

```sh
./node_modules/.bin/wrangler secret put ADMIN_EMAILS --config workers/notify/wrangler.toml
```

The handler sends nothing and returns 500 when the secret is missing, empty, or
contains an invalid or duplicate address. Callers cannot supply a recipient.

## Message

The handler builds the RFC 5322 message itself: CRLF line endings, a
quoted-printable UTF-8 body, and an RFC 2047 subject when the project name is
not ASCII. It removes control characters and line separators from every header
value, so request data cannot add a header. The body contains only the project
name and id, repository URL, applicant GitHub login and profile URL, submitted
time, application id, and the admin review link.

## Operator prerequisites

1. Configure Cloudflare email for the `slop.cash` zone so that the admin
   addresses can receive mail from `notifications@slop.cash`
   (`NOTIFY_FROM_ADDRESS`).
2. Create the `slop-notify` Worker once and set its `ADMIN_EMAILS` secret.
3. Set the repository variable `SLOP_NOTIFY_RELEASE` to `enabled`, and let one
   production release deploy the Worker.
4. The production binding in the root `wrangler.toml` connects Pages to the
   released Worker:

   ```toml
   [[services]]
   binding = "SLOP_NOTIFY"
   service = "slop-notify"
   ```

## Release and current scope

The protected production job in `.github/workflows/deploy.yml` releases this
Worker only when `SLOP_NOTIFY_RELEASE` is `enabled`. It requires exactly the
`ADMIN_EMAILS` secret, uploads a version tagged with the release commit,
promotes it to 100%, and verifies that the active version carries that tag.
Staging and preview deployments have no notification Worker or binding. Do not
use a local deployment to bypass the release workflow.

Run the handler checks with `bun run test:notify`; `bun run verify:code`
includes them. A deployed version is not proof of a caller, domain readiness or
inbox delivery.

## Restricted private bounty pilot (SEC-16)

The Worker also implements a separate private bounty delivery path. Migration
`0030_security_notification_outbox.sql` inserts one outbox row with each new
security inbox notice, in the same transaction. It does not send old notices
from before the migration. Case receipt times and award decisions do not
change when email fails.

This path is **not activated by the project-application binding**. The current
production release deliberately permits only `ADMIN_EMAILS`. A reviewed pilot
release must first qualify the separate staging audience and then add the
private D1 binding and the additional secret to the protected release's explicit
inventory. No addresses or private verification records belong in git.

The operator must provision:

- `SLOP_DB`: the isolated pilot D1 database with migration 0030. Use separate
  staging and production bindings. Do not attach production cases to a staging
  Worker.
- `SECURITY_MAIL_PILOT`: a JSON secret with `inboxUrl` (the exact HTTPS
  `/inbox` page on that environment) and `recipients`, keyed by immutable
  GitHub actor ID. Each entry contains `email`, ISO UTC `verifiedAt`, private
  `evidenceReference`, and `backupGithubId`. The operator verifies both control
  by that GitHub actor and Cloudflare's verified-destination eligibility.
  A GitHub public email, a caller's address or `ADMIN_EMAILS` is not this proof.
- A verified backup for each participant. The backup must also have a current
  role for the case. Mapping an address never grants case access. Record the
  program's approved escalation contact privately before activation.

Missing pilot configuration or D1 binding sends nothing. The checked-in schedule requests a run every five minutes. Wrangler version
upload/deploy does not apply cron triggers. The approved pilot release must
also apply that trigger through the protected workflow and verify the actual
trigger and a successful scheduled invocation. A secret and binding alone do
not establish scheduling. It reads current case roles again before each send.
Revoked roles are suppressed. A missing verified destination retries at one,
two, four and eight minutes, then exhausts after five attempts. The per-event,
recipient and template key prevents duplicate queue insertion; an atomic claim
prevents concurrent dispatch. Each message has one recipient and a stable
opaque per-attempt Message-ID, a generic subject and body, and the authenticated inbox
link. It has no tracking pixel, case identifier, project, advisory or amount.

A successful Cloudflare send is `provider-accepted`, never `delivered`. A thrown
send or an expired in-flight claim is `ambiguous`; neither is resent. A backup
notice is queued for a failed delivery or a missed acknowledgment, using the
program's existing `responseTargets.acknowledgeHours`. Backups are not escalated
recursively. A missing or unauthorized backup remains an operator readiness
gap, not a successful escalation.

Private operator service routes (no public routes or `workers.dev` endpoint):

- `POST https://notify.internal/v1/security-notifications/dispatch`, body `{}`,
  drains up to 25 due notices. The scheduler uses the same dispatcher.
- `POST https://notify.internal/v1/security-notifications/reconcile`, body with
  `deliveryId`, `attempt`, `destinationDigest`, `outcome` and `evidenceReference`, records independent provider
  evidence. Outcomes are `delivered`, `bounced`, `suppressed`, or `not-accepted`.
  Only the exact accepted or ambiguous attempt and destination can be reconciled.
  Each immutable provider evidence reference is accepted once; an old receipt
  cannot authorize another retry. `not-accepted`
  permits a bounded retry; it requires proof that the provider did not accept
  the attempt. Do not infer this from an exception. Do not expose this route
  through a browser or public proxy. Delivery evidence is append-only.

The signed-in recipient uses **Acknowledge** in `/inbox`. The page posts the
inbox event key to `/api/v1/security-cases/:id/acknowledge`; the server rechecks
session, current case role and exact recipient. The inbox returns the recorded
`acknowledgedAt`. Reading the notice, a delivery receipt or an email-open pixel
cannot set this value.

Before activation, run the isolated browser matrix and controlled mail sends
to the approved maintainer and reporter inboxes. Verify sender authentication,
quota, actual receipt, bounce/suppression, ambiguity recovery, backup escalation
and environment isolation. Local tests substitute the transport and do not
prove provider acceptance or inbox delivery. This code neither activates a
bounty nor selects a private payment rail.
