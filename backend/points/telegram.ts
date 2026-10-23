import { readBoundedJson } from "../../src/lib/browser-json";
import {
  constantTimeEqual,
  randomToken,
  sha256Hex,
} from "../../workers/identity/crypto";
import type { PointsDependencies } from "./handler";

/**
 * Telegram connection (protocol/points-v1.md "Telegram connections", PRD
 * SOC-02). The browser never talks to Telegram: `/start` issues a single-use
 * code behind a `t.me/<bot>?start=<code>` deep link, Telegram delivers the
 * member's `/start <code>` message to `/webhook`, and that delivery is the
 * proof of the numeric account ID. No award is recorded.
 */
export interface TelegramConfiguration {
  botToken: string;
  botUsername: string;
  webhookSecret: string;
}
const BOT_TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{30,64}$/;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const TELEGRAM_ID = /^[0-9]{1,20}$/;
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const START = /^\/start(?:@[A-Za-z0-9_]{1,32})?(?:[ \t]+(\S+))?\s*$/;
const FLOW_SECONDS = 600;

/** All three values or none; a partial or malformed set leaves Telegram disabled. */
export function telegramConfiguration(env: {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}): TelegramConfiguration | undefined {
  const token = env.TELEGRAM_BOT_TOKEN ?? "",
    username = env.TELEGRAM_BOT_USERNAME ?? "",
    secret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!token && !username && !secret) return undefined;
  if (
    !BOT_TOKEN.test(token) ||
    !BOT_USERNAME.test(username) ||
    !WEBHOOK_SECRET.test(secret)
  ) {
    console.warn("[Slop Telegram] Connections disabled: incomplete settings");
    return undefined;
  }
  return { botToken: token, botUsername: username, webhookSecret: secret };
}
function cookie(request: Request, name: string) {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
async function session(
  request: Request,
  deps: PointsDependencies,
  now: string,
) {
  const token = cookie(request, "__Host-slop_points");
  if (!token || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await deps.db
    .prepare(
      "SELECT actor_id FROM points_sessions WHERE token_hash=? AND expires_at>?",
    )
    .bind(hash, now)
    .first<{ actor_id: string }>();
  return row ? { actor: row.actor_id, hash } : null;
}
function publicFlag(body: unknown) {
  const value = body as Record<string, unknown> | null;
  return value &&
    Object.keys(value).join() === "public" &&
    typeof value.public === "boolean"
    ? value.public
    : null;
}
type Update = {
  message?: {
    from?: { id?: unknown; is_bot?: unknown; username?: unknown };
    chat?: { id?: unknown; type?: unknown };
    text?: unknown;
  };
};
type Flow = { actor_id: string; session_hash: string; public: number };
const REPLY = {
  connected:
    "Telegram connected to your Slop account. You can close this chat.",
  help: "Open slop.cash/account and choose Connect Telegram to link this account.",
  invalid:
    "This connection link is not valid any more. Open slop.cash/account and start again.",
  taken:
    "This Telegram account is already connected to another Slop account, so it cannot be connected again.",
  failed: "Slop could not record the connection. Please try again later.",
} as const;
async function reply(
  deps: PointsDependencies,
  config: TelegramConfiguration,
  chatId: string,
  text: string,
) {
  try {
    const response = await (deps.telegramFetch ?? fetch)(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      },
    );
    await response.body?.cancel();
  } catch {
    /* The reply is a courtesy; a recorded connection stands without it. */
  }
}
/**
 * Telegram posts every update here. The secret header set at `setWebhook`
 * authenticates the sender; nothing in the body is trusted beyond that.
 * Replies to a private `/start` only. Always 200 after authentication, so
 * Telegram never retries a consumed code.
 */
export async function handleTelegramWebhook(
  request: Request,
  deps: PointsDependencies,
  now: string,
): Promise<Response> {
  const config = deps.telegram;
  if (!config) return json(404, { error: "not_found" });
  if (request.method !== "POST") return json(405, { error: "method" });
  const presented = request.headers.get("x-telegram-bot-api-secret-token");
  if (!presented || !constantTimeEqual(presented, config.webhookSecret))
    return json(401, { error: "unauthorized" });
  let update: Update;
  try {
    update = (await readBoundedJson(
      request as unknown as Response,
      65536,
      "Telegram update",
    )) as Update;
  } catch {
    return json(200, { ok: true, handled: "unreadable" });
  }
  const message = update?.message;
  const from = message?.from,
    chat = message?.chat;
  if (
    !message ||
    chat?.type !== "private" ||
    from?.is_bot !== false ||
    typeof from.id !== "number" ||
    !Number.isSafeInteger(from.id) ||
    from.id <= 0 ||
    typeof chat.id !== "number" ||
    !Number.isSafeInteger(chat.id) ||
    typeof message.text !== "string"
  )
    return json(200, { ok: true, handled: "ignored" });
  const telegramId = String(from.id),
    chatId = String(chat.id);
  const start = START.exec(message.text);
  if (!start) return json(200, { ok: true, handled: "ignored" });
  const code = start[1];
  if (code === undefined) {
    await reply(deps, config, chatId, REPLY.help);
    return json(200, { ok: true, handled: "help" });
  }
  if (!CODE.test(code) || !TELEGRAM_ID.test(telegramId)) {
    await reply(deps, config, chatId, REPLY.invalid);
    return json(200, { ok: true, handled: "invalid" });
  }
  const username =
    typeof from.username === "string" && TELEGRAM_USERNAME.test(from.username)
      ? from.username
      : null;
  const hash = await sha256Hex(code);
  // Every failed path names a fixed stage. Never log the code, the chat,
  // usernames or identities.
  let stage = "flow_lookup";
  const flow = await deps.db
    .prepare(
      "UPDATE points_telegram_flows SET status='processing' WHERE code_hash=? AND status='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM points_sessions s WHERE s.token_hash=points_telegram_flows.session_hash AND s.actor_id=points_telegram_flows.actor_id AND s.expires_at>?) RETURNING actor_id,session_hash,public",
    )
    .bind(hash, now, now)
    .first<Flow>();
  if (!flow) {
    await reply(deps, config, chatId, REPLY.invalid);
    return json(200, { ok: true, handled: "invalid" });
  }
  try {
    stage = "record_connection";
    const result = await deps.db.batch([
      deps.db
        .prepare(
          "INSERT INTO points_telegram_claims(telegram_id,actor_id,claimed_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM points_sessions WHERE token_hash=? AND actor_id=? AND expires_at>?) AND EXISTS(SELECT 1 FROM points_telegram_flows WHERE code_hash=? AND status='processing') ON CONFLICT(telegram_id) DO NOTHING",
        )
        .bind(
          telegramId,
          flow.actor_id,
          now,
          flow.session_hash,
          flow.actor_id,
          now,
          hash,
        ),
      deps.db
        .prepare(
          "INSERT INTO points_telegram_links(actor_id,telegram_id,username,verified_at,public) SELECT actor_id,telegram_id,?,?,? FROM points_telegram_claims WHERE telegram_id=? AND actor_id=? AND EXISTS(SELECT 1 FROM points_sessions WHERE token_hash=? AND expires_at>?) AND EXISTS(SELECT 1 FROM points_telegram_flows WHERE code_hash=? AND status='processing') ON CONFLICT(actor_id) DO UPDATE SET telegram_id=excluded.telegram_id,username=excluded.username,verified_at=excluded.verified_at,public=excluded.public",
        )
        .bind(
          username,
          now,
          flow.public,
          telegramId,
          flow.actor_id,
          flow.session_hash,
          now,
          hash,
        ),
    ]);
    if (result.some((r) => !r.success)) throw new Error("batch");
    if (result[1].meta?.changes !== 1) {
      stage = "claim_conflict";
      const owner = await deps.db
        .prepare(
          "SELECT actor_id FROM points_telegram_claims WHERE telegram_id=?",
        )
        .bind(telegramId)
        .first<{ actor_id: string }>();
      if (owner && owner.actor_id !== flow.actor_id) {
        await reply(deps, config, chatId, REPLY.taken);
        return json(200, { ok: true, handled: "taken" });
      }
      throw new Error("link");
    }
    await reply(deps, config, chatId, REPLY.connected);
    return json(200, { ok: true, handled: "connected" });
  } catch {
    console.warn("[Slop Telegram] Connection failed", { stage });
    await reply(deps, config, chatId, REPLY.failed);
    return json(200, { ok: true, handled: "failed" });
  } finally {
    await deps.db
      .prepare("DELETE FROM points_telegram_flows WHERE code_hash=?")
      .bind(hash)
      .run();
  }
}
/** Same-origin browser routes under /api/v1/points/telegram. */
export async function handleTelegram(
  request: Request,
  deps: PointsDependencies,
  now: string,
): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.replace("/api/v1/points/telegram", "");
  const config = deps.telegram ?? null;
  if (route === "/profile" && request.method === "GET") {
    const actor = url.searchParams.get("actor") ?? "";
    if (!/^[A-Za-z0-9_=-]{4,256}$/.test(actor))
      return json(400, { error: "invalid_actor" });
    // The numeric Telegram ID stays private; only the username snapshot is shown.
    const link = await deps.db
      .prepare(
        "SELECT l.username,l.verified_at verifiedAt FROM points_telegram_links l JOIN points_members m ON m.actor_id=l.actor_id WHERE l.actor_id=? AND l.public=1 AND m.public=1",
      )
      .bind(actor)
      .first();
    return json(200, link);
  }
  const current = await session(request, deps, now);
  if (!current) return json(401, { error: "not_signed_in" });
  if (route === "/me" && request.method === "GET") {
    const account = await deps.db
      .prepare(
        "SELECT telegram_id id,username,verified_at verifiedAt,public FROM points_telegram_links WHERE actor_id=?",
      )
      .bind(current.actor)
      .first();
    const flow = await deps.db
      .prepare(
        "SELECT expires_at expiresAt FROM points_telegram_flows WHERE actor_id=? AND status='pending' AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
      )
      .bind(current.actor, now)
      .first();
    return json(200, { configured: !!config, account, flow });
  }
  if (route === "/start" && request.method === "POST") {
    if (!config) return json(503, { error: "telegram_not_configured" });
    const publish = publicFlag(
      await readBoundedJson(
        request as unknown as Response,
        256,
        "Telegram connection",
      ),
    );
    if (publish === null) return json(400, { error: "invalid_request" });
    const code = randomToken(32);
    const expires = new Date(
      Date.parse(now) + FLOW_SECONDS * 1000,
    ).toISOString();
    await deps.db.batch([
      deps.db
        .prepare(
          "DELETE FROM points_telegram_flows WHERE actor_id=? OR expires_at<=?",
        )
        .bind(current.actor, now),
      deps.db
        .prepare(
          "INSERT INTO points_telegram_flows(code_hash,session_hash,actor_id,expires_at,public,status) VALUES(?,?,?,?,?,'pending')",
        )
        .bind(
          await sha256Hex(code),
          current.hash,
          current.actor,
          expires,
          publish ? 1 : 0,
        ),
    ]);
    return json(200, {
      url: `https://t.me/${config.botUsername}?start=${code}`,
      expiresAt: expires,
    });
  }
  if (route === "/cancel" && request.method === "POST") {
    await deps.db
      .prepare("DELETE FROM points_telegram_flows WHERE actor_id=?")
      .bind(current.actor)
      .run();
    return json(200, { cancelled: true });
  }
  if (route === "/disconnect" && request.method === "POST") {
    await deps.db.batch([
      deps.db
        .prepare("DELETE FROM points_telegram_links WHERE actor_id=?")
        .bind(current.actor),
      deps.db
        .prepare("DELETE FROM points_telegram_flows WHERE actor_id=?")
        .bind(current.actor),
    ]);
    return json(200, { disconnected: true });
  }
  if (route === "/visibility" && request.method === "POST") {
    const publish = publicFlag(
      await readBoundedJson(
        request as unknown as Response,
        256,
        "Telegram visibility",
      ),
    );
    if (publish === null) return json(400, { error: "invalid_request" });
    const result = await deps.db
      .prepare("UPDATE points_telegram_links SET public=? WHERE actor_id=?")
      .bind(publish ? 1 : 0, current.actor)
      .run();
    return result.meta?.changes === 1
      ? json(200, { updated: true })
      : json(404, { error: "not_connected" });
  }
  return json(404, { error: "not_found" });
}
