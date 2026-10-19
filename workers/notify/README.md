# Slop notify Worker

`slop-notify` sends one plain-text email to each Slop admin when a person
submits a new project application. It exists because Pages Functions cannot use
`send_email` bindings.

## Route

The Worker has no public route and `workers_dev` is off. The caller is a
service binding named `SLOP_NOTIFY` on the production Pages app. That caller
is the authenticated project-application submit path in
`backend/projects/handler.ts`. Cloudflare refuses to publish Pages with a
binding to a Worker that does not exist, so `wrangler.toml` has no
`SLOP_NOTIFY` binding until the Worker is released. Without the binding, the
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
4. Then add the binding to the root `wrangler.toml` in a reviewed pull request:

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

This service implements project-application notices only. Private bounty
notifications require a separate approved event contract, restricted case
links and server-resolved recipient authorization under PRD SEC-16. Do not send
exploit details through the project-application template. No report is
submitted and no bounty award is approved by an email send.
