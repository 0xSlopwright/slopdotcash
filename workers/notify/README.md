# Slop notify Worker

`slop-notify` sends one plain-text email to each Slop admin when a person
submits a new project application. It exists because Pages Functions cannot use
`send_email` bindings.

## Route

The Worker has no public route and `workers_dev` is off. The Pages app binds it
as the service `SLOP_NOTIFY` and calls the only accepted route:

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
| 202    | `{"status":"sent","recipients":2}`           | Every admin email was handed to Cloudflare. |
| 502    | `{"error":"delivery_failed","sent":<n>}`     | At least one send failed; `n` were sent. |
| 500    | `{"error":"service_misconfigured"}`          | The sender address is invalid; nothing was sent. |

A 202 means Cloudflare accepted the messages. It does not prove inbox delivery.

## Recipients

The recipient list is fixed in `ADMIN_NOTIFICATION_RECIPIENTS` in
`contracts.ts`. The `ADMIN_EMAIL` binding in `wrangler.toml` must allow exactly
the same addresses. To change the list, update both files in the same pull
request; the test suite fails when they differ.

## Message

The handler builds the RFC 5322 message itself: CRLF line endings, a
quoted-printable UTF-8 body, and an RFC 2047 subject when the project name is
not ASCII. It removes control characters and line separators from every header
value, so request data cannot add a header. The body contains only the project
name and id, repository URL, applicant GitHub login and profile URL, submitted
time, application id, and the admin review link.

## Operator prerequisites

1. Enable Cloudflare Email Routing on the `slop.cash` zone.
2. Add and verify both recipient addresses as Email Routing destination
   addresses.
3. Keep the sender `notifications@slop.cash` (`NOTIFY_FROM_ADDRESS`) on that
   zone.
4. Deploy this Worker, then bind it to the Pages project as the service
   `SLOP_NOTIFY`.

## Release and current scope

The protected production job in `.github/workflows/deploy.yml` deploys this
Worker from its checked-out release revision before publishing the Pages
service binding. Preview deployments have no notification binding. Do not
use a local deployment to bypass the release workflow.

Run existing handler checks with `bun test workers/notify/notify.test.ts`.
Verify the deployed version and email binding separately from domain readiness.
The domain's Email Sending activation does not deploy this Worker.

This service implements project-application notices only. The released application
must supply an authenticated caller before these notices can be sent. Private
bounty notifications require a separate approved event contract, restricted case
links and server-resolved recipient authorization under PRD SEC-16. Do not send
exploit details through the project-application template. No report is submitted
and no bounty award is approved by an email send.
