/**
 * Inbox event statements (PRD NOT-01, migration 0024). Each writer adds one
 * of these to the same D1 batch as its source change, after that change, so
 * the notification commits only with it. Every statement reads its facts
 * back from the committed source row, so a change that did not happen writes
 * nothing, and the (event_key, recipient) key makes a replay a no-op.
 */

type Preparer<S> = {
  prepare(query: string): { bind(...values: unknown[]): S };
};

const INSERT = `INSERT INTO notifications (
  event_key, recipient_github_id, kind, subject, detail, action_path,
  source_at, created_at
)`;
const ONCE = "ON CONFLICT (event_key, recipient_github_id) DO NOTHING";

/** An admin decision on a project application reaches the applicant. */
export function notifyApplicationDecision<S>(
  db: Preparer<S>,
  applicationId: string,
  decidedAt: string,
): S {
  return db
    .prepare(
      `${INSERT}
       SELECT 'project-application:' || id || ':' || status,
              applicant_github_id, 'application_' || status, project_id,
              decision_reason,
              CASE status WHEN 'approved' THEN '/projects/' || project_id
                          ELSE '/projects/new' END,
              decided_at, ?
         FROM project_applications
        WHERE id = ? AND status IN ('approved', 'rejected') AND decided_at = ?
       ${ONCE}`,
    )
    .bind(decidedAt, applicationId, decidedAt);
}

/**
 * A later manifest revision reaches the applicant who listed the project and
 * its GitHub steward. Revision 1 is the approval, which has its own event.
 */
export function notifyProjectRevision<S>(
  db: Preparer<S>,
  projectId: string,
  revision: number,
  manifestSha256: string,
  at: string,
): S {
  return db
    .prepare(
      `${INSERT}
       SELECT 'project-revision:' || r.project_id || ':' || r.revision,
              recipient, 'project_revision', r.project_id, r.reason,
              '/projects/' || r.project_id, r.created_at, ?4
         FROM project_revisions r
         JOIN (
           SELECT a.applicant_github_id AS recipient
             FROM projects p
             JOIN project_applications a ON a.id = p.source_application_id
            WHERE p.id = ?1
           UNION
           SELECT json_extract(manifest, '$.steward.github.actorId')
             FROM project_revisions
            WHERE project_id = ?1 AND revision = ?2
              AND json_type(manifest, '$.steward.github.actorId') = 'text'
         )
        WHERE r.project_id = ?1 AND r.revision = ?2 AND r.revision > 1
          AND r.manifest_sha256 = ?3 AND r.created_at = ?4
          AND recipient GLOB '[1-9]*' AND recipient NOT GLOB '*[^0-9]*'
       ${ONCE}`,
    )
    .bind(projectId, revision, manifestSha256, at);
}

/** A finalized reservation: an award is now set aside for the contributor. */
export function notifyAwardReserved<S>(
  db: Preparer<S>,
  obligationId: string,
  at: string,
): S {
  return db
    .prepare(
      `${INSERT}
       SELECT 'payment-reserved:' || id, github_user_id, 'award_reserved',
              project_id, NULL, '/earnings', created_at, ?
         FROM payment_obligations WHERE id = ?
       ${ONCE}`,
    )
    .bind(at, obligationId);
}

/** A finalized payout transaction to the contributor's authorized wallet. */
export function notifyPaymentPaid<S>(
  db: Preparer<S>,
  obligationId: string,
  transactionId: string,
  at: string,
): S {
  return db
    .prepare(
      `${INSERT}
       SELECT 'payment-paid:' || o.id, o.github_user_id, 'payment_paid',
              o.project_id, NULL, '/earnings', e.observed_at, ?
         FROM payment_obligations o
         JOIN payment_events e
           ON e.obligation_id = o.id AND e.kind = 'paid'
          AND e.transaction_id = o.paid_transaction
        WHERE o.id = ? AND o.state = 'paid' AND o.paid_transaction = ?
       ${ONCE}`,
    )
    .bind(at, obligationId, transactionId);
}

/** A held payout; each hold is its own event, keyed by its time. */
export function notifyPayoutHeld<S>(
  db: Preparer<S>,
  obligationId: string,
  heldAt: string,
): S {
  return db
    .prepare(
      `${INSERT}
       SELECT 'payout-held:' || q.obligation_id || ':' || q.updated_at,
              o.github_user_id, 'payout_held', o.project_id, NULL,
              '/earnings', q.updated_at, ?
         FROM payment_outbox q
         JOIN payment_obligations o ON o.id = q.obligation_id
        WHERE q.obligation_id = ? AND q.state = 'held' AND q.updated_at = ?
       ${ONCE}`,
    )
    .bind(heldAt, obligationId, heldAt);
}

/** A new or replacement payout wallet is an account-security event. */
export function notifyWalletChanged<S>(
  db: Preparer<S>,
  claimId: string,
  at: string,
): S {
  return db
    .prepare(
      `${INSERT}
       SELECT 'wallet-claim:' || id, github_user_id, 'wallet_changed', chain,
              NULL, '/account#wallets', created_at, ?
         FROM wallet_claims WHERE id = ?
       ${ONCE}`,
    )
    .bind(at, claimId);
}
