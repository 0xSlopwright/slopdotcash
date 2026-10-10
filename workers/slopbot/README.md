# Slopbot worker

Hosted Slopbot GitHub App service under `protocol/slopbot-v2.md` (approved
9 October 2026; PRD BOT-08 to BOT-13). It is not deployed yet, and closing is
disabled by `SLOPBOT_CLOSURE_ENABLED = "false"`.

## Flow

1. `POST /github/webhook` verifies `X-Hub-Signature-256`, records the delivery
   ID once, updates installation state, and enqueues identifiers only.
2. The queue consumer gets an installation token and re-reads the
   repository, the item, `.github/slopbot.json`, and `AGENTS.md`,
   `CONTRIBUTING.md` and `README.md` from the default branch at its current
   SHA.
3. `routing.ts` applies the published precedence: installation, private
   repository, type switch, open/draft, bot author, human reopen, exemption,
   audience, author cap, budget.
4. Deterministic pre-filters (empty, same-author duplicate) run without a model.
5. `models.ts` runs triage: Surplus `claude-opus-5.5`, then Surplus
   `gpt-6.1-sol` as fallback (owner decision, 9 October 2026). Every call is written to
   `slopbot_costs` with cost and billed amount (cost + 10%).
6. A close needs all of the following:
   - the category set to `close`;
   - verified evidence;
   - for guidance categories, a rule quoted verbatim from the named file;
   - confidence ≥ 0.9;
   - closure enabled globally and by the repository;
   - the shadow period over;
   - no circuit breaker and no daily cap hit;
   - a confirming second verdict (Surplus, falling back to GPT-6.1 Sol);
   - an unchanged item just before acting.

   Otherwise the bot only comments and labels.
7. `/slopbot appeal` from the author, or any reopen, blocks re-closing that
   revision.

## Repository policy file

`.github/slopbot.json` on the default branch:

```json
{
  "version": 1,
  "audience": "protection",
  "issues": true,
  "pullRequests": true,
  "closure": false,
  "categories": { "out_of_scope": "label", "spam": "close" }
}
```

A missing or invalid file means label-only review.

## Cost statements and vault billing

`GET /api/v1/payments/slopbot/installations/<id>/invoices/<YYYY-MM>` returns
one installation's billed model calls for the UTC month. Values use integer
micro-USDC. This is a cost statement, not a request for payment or proof of
settlement. The fee offset is zero until a reviewed project binding exists.

Billing must use the existing project vaults under PAY-10. The owner authorizes
`chargeService` on Base or `charge_service` on Solana. The operation must use
only free sponsor funds, preserve reserved awards and donor funds, and prevent
a second charge for the same invoice digest. Neither contract has that
operation yet; finalized invoice reconciliation is also required before launch.
Issue #616 tracks these dependencies.

Do not send service deposits to payout-fee wallets. There is no public prepaid
deposit-credit endpoint. A past fee transfer must never become new service
credit. This change neither enables billing nor moves funds.

## Setup checklist (owner)

Do these in order. Each step names who does it and how to verify it.

1. **Use the registered App** (an org owner of SlopDotCash):
   [slopdotcash](https://github.com/apps/slopdotcash), App ID `5257625`.
   Do not create a second App or use the unrelated `slopcash` App.
   - Homepage: `https://slop.cash`.
   - Webhook: active. URL: `https://<worker host>/github/webhook`. Set this
     after step 6; until then, leave the webhook inactive.
   - Webhook secret: generate with `openssl rand -hex 32` and keep it for
     step 4.
   - Permissions: Contents read, Metadata read, Organization members read,
     Issues write, Pull requests write. No others.
   - Events: Installation, Issues, Issue comment, Pull request.
   - "Where can this App be installed": Any account.
   - Verify: the App page shows exactly these permissions.
2. **Get the App identity:**
   - Record the App ID shown on the App page.
   - Get the bot user ID from `https://api.github.com/users/slopdotcash%5Bbot%5D`
     (the `id` field).
3. **Create the key:** on the App page, click "Generate a private key". Then
   convert it:
   `openssl pkcs8 -topk8 -nocrypt -in slopbot.private-key.pem -out slopbot.pkcs8.pem`.
   Delete both files after step 4.
4. **Add the Cloudflare secrets** (account owner), using
   `bunx wrangler secret put <NAME> --config workers/slopbot/wrangler.toml`
   for each of:
   - `SLOPBOT_WEBHOOK_SECRET`
   - `SLOPBOT_APP_ID`
   - `SLOPBOT_APP_USER_ID`
   - `SLOPBOT_APP_PRIVATE_KEY` (the PKCS#8 PEM)
   - `SURPLUS_API_KEY`

   Both models use the same Surplus key. The default Anthropic-compatible
   base URL is `https://api.surplusintelligence.ai/anthropic`. Optionally set
   `SURPLUS_BASE_URL` for another verified Surplus Anthropic endpoint.
5. **Create the queues in the production Cloudflare account** (the account
   in the `CLOUDFLARE_ACCOUNT_ID` environment secret, which also holds
   `slop-private` and the `eliza-computer` Pages project):
   `bunx wrangler queues create slopbot-jobs` and
   `bunx wrangler queues create slopbot-jobs-dlq`. A personal Cloudflare
   login is a different account; check with `bunx wrangler whoami` and
   `bunx wrangler d1 list` (it must list `slop-private`) first.
6. **One-time bootstrap (owner, after claiming the deploy lever):**
   1. In Cloudflare → Workers, create a Worker named `slop-slopbot` from the
      "Hello World" template. Do not deploy from a local tree.
   2. Add the custom domain `slopbot.slop.cash` to that Worker.
   3. Add the step 4 secrets.
   4. Attach the queue consumer:
      `bunx wrangler queues consumer add slopbot-jobs slop-slopbot --batch-size 5 --message-retries 5 --dead-letter-queue slopbot-jobs-dlq`.
   5. In GitHub → repository Settings → Variables, set `SLOPBOT_RELEASE` to
      `enabled`.

   The next protected release runs these steps:
   - checks the secret inventory;
   - uploads and promotes the version bound to the release SHA;
   - probes `https://slopbot.slop.cash/health`.

   Then set the App webhook URL to `https://slopbot.slop.cash/github/webhook`
   and activate it.
7. **Verify live:**
   - `GET /health` returns `{"service":"slopbot","ok":true}`.
   - The App's "Advanced" tab shows `202` for the ping delivery.
8. **Qualify billing for the dogfood installation:** install the App on
   `SlopDotCash/slopdotcash` only. There is no free allowance. Keep billable
   review disabled until the vault service-charge path and invoice
   reconciliation are qualified.
9. **Observe the shadow period:** review the labels and comments for at least
   14 days and 50 items, with `SLOPBOT_CLOSURE_ENABLED` still `"false"`.
   Enabling closure later is a separate reviewed PR that sets the variable
   and records the agreement data.

## App permissions and events

- **Read:** Contents, Metadata, Organization members.
- **Write:** Issues, Pull requests.
- **Events:** `installation`, `issues`, `issue_comment`, `pull_request`.

## Not yet implemented

- There is no free allowance. Review stays blocked until billing is qualified.
- Vault service charging and finalized invoice reconciliation (PAY-10/BOT-11).
- Reviewed installation-to-project binding and payout-fee offsets.
- SCR-01 penalty journal events. Closures record `penaltyEligible` for them.
- Maintainer dashboard and Automation row (LDR-04).

## Value assessment work in progress

The owner approved automatic **provisional** value scores under PRD SCR-06.
Payout approval stays human. See
[`slop-value-scoring-plan.md`](../../docs/slop-value-scoring-plan.md) for the
separate delivery checklist. This does not activate the closure switch.

`value-evidence.ts` collects paginated submitted changes, reported merge changes,
commit identities and discussion evidence. It reports missing patches, source
drift, API file limits and merge ancestry that needs joint review. A matching
squash diff can establish the accepted range; the final commit of a rebase or a
branch-sync diff cannot establish that range on its own. A read-only local
collection uses:

```bash
bun scripts/collect-value-evidence.ts OWNER/REPOSITORY PR_NUMBER /private/output
```

Raw evidence stays outside the repository. `value-review.ts` shares the strict
value rubric with the hosted model route. It does not publish scores or approve
awards. Source-bound publication, ingestion and complete historical calibration
must pass before this route can be activated. The September/October review uses
the owner's existing ChatGPT subscription; it does not authorize paid API calls.
A hosted service still requires its own supported runtime credentials.

Local evidence checks used real GitHub sources: Eliza #34772 has matching full
submitted and squash diffs; Delta Star #218 correctly requires ancestry review;
Delta Star #215 reports an omitted original-file patch instead of claiming full
coverage. These checks do not prove model execution or score publication.

Installation was verified on 10 October 2026: the owner installed the registered
App on elizaOS (installation `169856061`) with all repositories selected. This
proves App access, not worker deployment, model connectivity or score delivery.

## Runtime verification (10 October 2026)

The owner-supplied Surplus key passed live structured calls for
`claude-opus-5.5` and `gpt-6.1-sol` through the Anthropic endpoint above.
An unavailable primary model also exercised the live Sol fallback. These
checks used the same `runStructuredRoute` function as the worker. The endpoint
reports the served model; that report is not independent model attestation.

The marketplace response did not follow the requested schema when it was
provided only in `output_config`. The route now includes the exact schema in
the trusted prompt and still rejects every response that fails local validation.
Provider error bodies are not persisted. A model identity mismatch also fails.

A fresh read of Eliza #34772 resolved co-authors through GitHub's pinned commit
mapping, collected complete diff and discussion evidence, and produced a valid
Opus value assessment covering all three formal reviews. Email addresses used
to join co-author identities are omitted from the evidence export. This was a
local, read-only runtime test. A first schema-valid result double-credited the
same review finding. The rubric now requires explicit `duplicateOf` references
to earlier review identities; a duplicate cannot receive positive credit. A
subsequent live result identified the repeated finding correctly. Validation of
superseded heads still needs evidence of distinct retained value. Schema validity
alone is not semantic calibration. The test did not publish a score, run the hosted queue,
activate billing, or approve a payout. Hosted delivery and historical calibration
remain on the value-scoring acceptance checklist.


## Provisional assessment journal

`value-journal.ts` prepares source-bound records for the append-only D1 table
in migration `0014`. It revalidates the assessment against its exact evidence,
policy digest and configured served-model identity. The record contains the
safe rationale and source links, not patches, raw responses or prompts.

An exact source/rubric/producer retry returns the first canonical record.
A successor must name its predecessor and explain the change. The database
rejects competing successors, predecessors from another PR, edits and deletes.
The exact stored JSON bytes define the record digest. Consumers must retain
those bytes when they verify a record.

A local integration check applied the checked-in migration to real SQLite and
used the two real Eliza runtime assessments. It verified replay, digest/key
integrity, successor readback, retained history, and rejection of cross-PR
predecessors and competing successors. This is storage evidence only. No
production migration was applied. `value-publication.ts` checks the active
installation, its token-scoped repository membership, the exact repository IDs,
and freshly collected complete source and pinned policy. The insert also checks
installation state to reject a suspension/removal that arrives during the read.
The live source recheck matched Eliza #34772. Hosted App authentication remains
untested while credentials are pending.

The read-only `GET /v1/value-assessments?repository=OWNER/REPO&pull=NUMBER`
route returns ordered record strings and their digests. It accepts an `after`
sequence cursor, returns up to 100 records, and supplies `nextAfter` when another
page exists. Invalid queries return 400. A storage failure returns 503, never a
successful empty history. This route shows recorded history; it does not assert
that a record still matches GitHub or overrides a human decision.

A local Cloudflare Worker with local D1 passed HTTP readback using the checked-in
migrations and seeded real Eliza assessments. All returned record digests matched
the exact bytes; cursor reads, valid empty history and invalid-query responses
also passed. This does not prove hosted authentication, queue delivery or a
production write.

Queue scheduling, inference budget accounting, score/Points ingestion and human
precedence remain required before activation. No hosted queue has published a
record. Only the internal publisher may establish authority for a write; the
public reader cannot submit or alter assessments.


## Provider request receipts

The Anthropic SDK response headers carry Surplus transport evidence. The route
retains `x-si-buyer-cost-micro` as a nullable integer in a separate immutable
`provider_cost_micro_usd` column (migration `0015`). Missing, fractional or
unsafe values remain unknown. This is a provider report, not a finalized invoice;
it does not replace the versioned price, change billing, or mark reconciliation
complete. Only this allowlisted numeric header is retained.

`x-si-truncated: 1` rejects the response even if its JSON and stop reason appear
complete. SDK retries are disabled so each explicit route attempt has one cost
record. Failure responses retain a valid cost header without recording provider
error bodies. See the official [Surplus routing controls](https://www.surplusintelligence.ai/docs/marketplace/routing-controls).

Live Opus and Sol receipt checks passed on 10 October 2026. Controlled local HTTP
checks covered deadline truncation, fractional costs, error receipts and retry
count; the real SQLite migrations preserved the receipt and rejected its update.
Those local checks did not charge a contributor or reconcile a production invoice.
