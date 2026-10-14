// Slopbot GitHub App service (draft, docs/slopbot-v2-proposal.md).
// fetch: verify and deduplicate webhooks, then enqueue identifiers only.
// queue: re-read GitHub state and run the review pipeline.
import type { Job } from "./contracts";
import { verifyWebhookSignature } from "./github";
import * as store from "./persistence";
import { type ReviewEnv, recordHumanSignal, reviewItem } from "./review";
import { readWebhookBody } from "./webhook-body";

type Queue = { send(body: Job): Promise<void> };
type Env = Omit<ReviewEnv, "SLOPBOT_DB"> & {
  SLOPBOT_DB: store.D1TransactionalDatabase;
  SLOPBOT_WEBHOOK_SECRET: string;
  SLOPBOT_QUEUE: Queue;
};

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;
const REVIEW_ACTIONS: Record<string, ReadonlySet<string>> = {
  issues: new Set(["opened", "edited"]),
  pull_request: new Set([
    "opened",
    "edited",
    "synchronize",
    "ready_for_review",
  ]),
};

type Payload = {
  action?: string;
  installation?: {
    id: number;
    account?: { id: number; login: string; type: string };
    updated_at?: string | number;
  };
  repository?: { id: number; name: string; owner: { login: string } };
  sender?: { id: number; type: string };
  issue?: { number: number; pull_request?: unknown };
  pull_request?: { number: number };
  comment?: { body: string };
};

function jobFor(
  event: string,
  deliveryId: string,
  payload: Payload,
  appUserId: string,
): Job | null {
  const { installation, repository, sender, action } = payload;
  if (
    installation === undefined ||
    repository === undefined ||
    sender === undefined ||
    action === undefined
  )
    return null;
  if (String(sender.id) === appUserId) return null;
  const base = {
    deliveryId,
    installationId: installation.id,
    repositoryId: repository.id,
    owner: repository.owner.login,
    repo: repository.name,
  };
  const item =
    event === "pull_request" && payload.pull_request !== undefined
      ? {
          itemKind: "pull_request" as const,
          number: payload.pull_request.number,
        }
      : payload.issue !== undefined
        ? {
            itemKind:
              payload.issue.pull_request === undefined
                ? ("issue" as const)
                : ("pull_request" as const),
            number: payload.issue.number,
          }
        : null;
  if (item === null) return null;
  if (event === "issue_comment") {
    if (
      action !== "created" ||
      !(payload.comment?.body ?? "").trim().startsWith("/slopbot appeal")
    )
      return null;
    return { kind: "appeal", ...base, ...item, senderId: sender.id };
  }
  if (action === "reopened")
    return { kind: "human_reopen", ...base, ...item, senderId: sender.id };
  if (REVIEW_ACTIONS[event]?.has(action))
    return { kind: "review", ...base, ...item };
  return null;
}

async function handleInstallation(
  env: Env,
  payload: Payload,
  deliveryId: string,
) {
  const installation = payload.installation;
  if (installation?.account === undefined) {
    await store.completeInstallationDelivery(env.SLOPBOT_DB, deliveryId, null);
    return;
  }
  const rawUpdatedAt = installation.updated_at;
  const sourceUpdatedAt =
    typeof rawUpdatedAt === "number"
      ? rawUpdatedAt * 1000
      : typeof rawUpdatedAt === "string"
        ? Date.parse(rawUpdatedAt)
        : Number.NaN;
  if (!Number.isSafeInteger(sourceUpdatedAt) || sourceUpdatedAt < 0) {
    throw new Error("installation.updated_at is invalid");
  }
  if (
    payload.action === "created" ||
    payload.action === "new_permissions_accepted"
  ) {
    await store.completeInstallationDelivery(env.SLOPBOT_DB, deliveryId, {
      kind: "upsert",
      installation: { id: installation.id, account: installation.account },
      sourceUpdatedAt,
    });
  } else if (payload.action === "deleted") {
    await store.completeInstallationDelivery(env.SLOPBOT_DB, deliveryId, {
      kind: "state",
      installation: { id: installation.id, account: installation.account },
      state: "removed",
      sourceUpdatedAt,
    });
  } else if (payload.action === "suspend") {
    await store.completeInstallationDelivery(env.SLOPBOT_DB, deliveryId, {
      kind: "state",
      installation: { id: installation.id, account: installation.account },
      state: "suspended",
      sourceUpdatedAt,
    });
  } else if (payload.action === "unsuspend") {
    await store.completeInstallationDelivery(env.SLOPBOT_DB, deliveryId, {
      kind: "state",
      installation: { id: installation.id, account: installation.account },
      state: "active",
      sourceUpdatedAt,
    });
  } else {
    await store.completeInstallationDelivery(env.SLOPBOT_DB, deliveryId, null);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "slopbot", ok: true });
    }
    if (request.method !== "POST" || url.pathname !== "/github/webhook") {
      return new Response("not found", { status: 404 });
    }
    const body = await readWebhookBody(request, MAX_WEBHOOK_BYTES);
    if (body === null) {
      return new Response("payload too large", { status: 413 });
    }
    if (
      !(await verifyWebhookSignature(
        env.SLOPBOT_WEBHOOK_SECRET,
        body,
        request.headers.get("x-hub-signature-256"),
      ))
    ) {
      return new Response("invalid signature", { status: 401 });
    }
    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery") ?? "";
    if (deliveryId === "")
      return new Response("missing delivery id", { status: 400 });
    if (event === "installation") {
      const payload = JSON.parse(new TextDecoder().decode(body)) as Payload;
      if (
        !(await store.claimInstallationDelivery(
          env.SLOPBOT_DB,
          deliveryId,
          event,
        ))
      ) {
        return new Response("duplicate delivery", { status: 202 });
      }
      await handleInstallation(env, payload, deliveryId);
      return new Response("ignored", { status: 202 });
    }
    if (!(await store.recordDelivery(env.SLOPBOT_DB, deliveryId, event))) {
      return new Response("duplicate delivery", { status: 202 });
    }
    try {
      const payload = JSON.parse(new TextDecoder().decode(body)) as Payload;
      const job = jobFor(event, deliveryId, payload, env.SLOPBOT_APP_USER_ID);
      if (job !== null) await env.SLOPBOT_QUEUE.send(job);
      return new Response(job === null ? "ignored" : "queued", {
        status: 202,
      });
    } catch (error) {
      await store.releaseDelivery(env.SLOPBOT_DB, deliveryId);
      throw error;
    }
  },

  async queue(
    batch: {
      messages: {
        body: Job;
        ack(): void;
        retry(options?: { delaySeconds?: number }): void;
      }[];
    },
    env: Env,
  ) {
    for (const message of batch.messages) {
      try {
        const outcome =
          message.body.kind === "review"
            ? await reviewItem(env, message.body)
            : await recordHumanSignal(env, message.body);
        console.log(
          JSON.stringify({
            delivery: message.body.deliveryId,
            kind: message.body.kind,
            outcome,
          }),
        );
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            delivery: message.body.deliveryId,
            error: String(error).slice(0, 300),
          }),
        );
        // Back off for GitHub's secondary content-creation limits (BOT-13).
        message.retry({ delaySeconds: 60 });
      }
    }
  },
};
