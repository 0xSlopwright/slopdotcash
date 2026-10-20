// Runs the Telegram connection routes against the real migrations: the deep
// link code is single use, Telegram's delivery of `/start <code>` is the only
// proof, a Telegram account stays reserved to the first GitHub identity, and
// the visible link needs both opt-ins.
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { sha256Hex } from "../../workers/identity/crypto";
import type { D1Database } from "../trace/cloudflare-persistence";
import { handlePointsApi, type PointsDependencies } from "./handler";
import { telegramConfiguration } from "./telegram";

const migrations = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();
const ORIGIN = "https://slop.cash";
const START = "2026-10-20T12:00:00.000Z";
const BOT = {
  botToken: `123456789:${"A".repeat(35)}`,
  botUsername: "slop_connect_bot",
  webhookSecret: "w".repeat(48),
};
const ONE = { actor: "U_member_one", githubId: "1001", login: "member-one" };
const TWO = { actor: "U_member_two", githubId: "1002", login: "member-two" };

type Sent = { url: string; body: { chat_id: string; text: string } };

function harness() {
  const { db, sqlite } = sqliteD1(migrations);
  const sent: Sent[] = [];
  let clock = Date.parse(START);
  const deps: PointsDependencies = {
    tier: "production",
    db: db as unknown as D1Database,
    rateLimitSecret: "r".repeat(48),
    identity: { fetch: async () => new Response(null, { status: 500 }) },
    now: () => new Date(clock),
    telegram: BOT,
    telegramFetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{"ok":true}', { status: 200 });
    },
  };
  const tokens = new Map<string, string>();
  async function member(m: typeof ONE, isPublic = 1) {
    const token = `${m.actor}-${"t".repeat(48)}`;
    tokens.set(m.actor, token);
    sqlite
      .prepare(
        "INSERT INTO points_members(actor_id,github_id,login,joined_at,public) VALUES(?,?,?,?,?)",
      )
      .run(m.actor, m.githubId, m.login, START, isPublic);
    sqlite
      .prepare(
        "INSERT INTO points_sessions(token_hash,actor_id,expires_at) VALUES(?,?,?)",
      )
      .run(
        await sha256Hex(token),
        m.actor,
        new Date(clock + 3_600_000).toISOString(),
      );
  }
  async function call(
    path: string,
    options: { as?: typeof ONE; body?: unknown; method?: string } = {},
  ) {
    const method =
      options.method ?? (options.body === undefined ? "GET" : "POST");
    const headers = new Headers();
    if (options.as)
      headers.set(
        "cookie",
        `__Host-slop_points=${tokens.get(options.as.actor) ?? ""}`,
      );
    if (method === "POST") {
      headers.set("origin", ORIGIN);
      headers.set("content-type", "application/json");
      headers.set("cf-connecting-ip", "203.0.113.7");
    }
    const response = await handlePointsApi(
      new Request(`${ORIGIN}/api/v1/points${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(options.body ?? {}) : null,
      }),
      deps,
    );
    return { status: response.status, body: await response.json() };
  }
  async function webhook(update: unknown, secret = BOT.webhookSecret) {
    const response = await handlePointsApi(
      new Request(`${ORIGIN}/api/v1/points/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secret,
        },
        body: JSON.stringify(update),
      }),
      deps,
    );
    return { status: response.status, body: await response.json() };
  }
  function startMessage(
    text: string,
    from: { id: number; username?: string; is_bot?: boolean } = { id: 777 },
    chat: { id?: number; type?: string } = {},
  ) {
    return {
      update_id: 1,
      message: {
        message_id: 1,
        from: { is_bot: false, first_name: "A", username: "alice_tg", ...from },
        chat: { id: from.id, type: "private", ...chat },
        date: 1,
        text,
      },
    };
  }
  function codeOf(url: string) {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://t.me");
    expect(parsed.pathname).toBe(`/${BOT.botUsername}`);
    return parsed.searchParams.get("start") ?? "";
  }
  async function connect(
    m: typeof ONE,
    from?: { id: number; username?: string },
  ) {
    const started = await call("/telegram/start", {
      as: m,
      body: { public: false },
    });
    expect(started.status).toBe(200);
    const code = codeOf(started.body.url);
    return webhook(startMessage(`/start ${code}`, from));
  }
  return {
    sqlite,
    sent,
    member,
    call,
    webhook,
    startMessage,
    codeOf,
    connect,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("telegramConfiguration", () => {
  test("needs all three values with the documented shapes", () => {
    expect(telegramConfiguration({})).toBeUndefined();
    expect(
      telegramConfiguration({ TELEGRAM_BOT_TOKEN: BOT.botToken }),
    ).toBeUndefined();
    expect(
      telegramConfiguration({
        TELEGRAM_BOT_TOKEN: BOT.botToken,
        TELEGRAM_BOT_USERNAME: "bad name",
        TELEGRAM_WEBHOOK_SECRET: BOT.webhookSecret,
      }),
    ).toBeUndefined();
    expect(
      telegramConfiguration({
        TELEGRAM_BOT_TOKEN: BOT.botToken,
        TELEGRAM_BOT_USERNAME: BOT.botUsername,
        TELEGRAM_WEBHOOK_SECRET: BOT.webhookSecret,
      }),
    ).toEqual(BOT);
  });
});

describe("Telegram connection", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.member(ONE);
    await h.member(TWO);
  });

  test("start needs a signed-in member and issues a ten-minute single-use deep link", async () => {
    expect(
      (await h.call("/telegram/start", { body: { public: true } })).status,
    ).toBe(401);
    expect(
      (await h.call("/telegram/start", { as: ONE, body: { public: "yes" } }))
        .status,
    ).toBe(400);
    const started = await h.call("/telegram/start", {
      as: ONE,
      body: { public: true },
    });
    expect(started.status).toBe(200);
    expect(h.codeOf(started.body.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.body.expiresAt).toBe("2026-10-20T12:10:00.000Z");
    const me = await h.call("/telegram/me", { as: ONE });
    expect(me.body).toEqual({
      configured: true,
      account: null,
      flow: { expiresAt: "2026-10-20T12:10:00.000Z" },
    });
    // A second start replaces the first code; the old one no longer resolves.
    const again = await h.call("/telegram/start", {
      as: ONE,
      body: { public: true },
    });
    const stale = await h.webhook(
      h.startMessage(`/start ${h.codeOf(started.body.url)}`),
    );
    expect(stale.body.handled).toBe("invalid");
    expect(
      h.sqlite.query("SELECT count(*) n FROM points_telegram_flows").get(),
    ).toEqual({ n: 1 });
    expect(h.codeOf(again.body.url)).not.toBe(h.codeOf(started.body.url));
  });

  test("webhook rejects a wrong secret and ignores anything but a private /start", async () => {
    expect((await h.webhook(h.startMessage("/start x"), "nope")).status).toBe(
      401,
    );
    expect((await h.webhook(h.startMessage("/start x"), "")).status).toBe(401);
    const group = await h.webhook(
      h.startMessage(
        "/start abc",
        { id: 777 },
        { id: -100, type: "supergroup" },
      ),
    );
    expect(group.body.handled).toBe("ignored");
    const bot = await h.webhook(
      h.startMessage("/start abc", { id: 777, is_bot: true }),
    );
    expect(bot.body.handled).toBe("ignored");
    const chatter = await h.webhook(h.startMessage("hello there"));
    expect(chatter.body.handled).toBe("ignored");
    const bare = await h.webhook(h.startMessage("/start"));
    expect(bare.body.handled).toBe("help");
    const malformed = await h.webhook(h.startMessage("/start not-a-code"));
    expect(malformed.body.handled).toBe("invalid");
    expect(h.sent.map((s) => s.body.text.slice(0, 4))).toEqual([
      "Open",
      "This",
    ]);
    expect(
      h.sent.every(
        (s) =>
          s.url === `https://api.telegram.org/bot${BOT.botToken}/sendMessage`,
      ),
    ).toBe(true);
    expect(
      h.sqlite.query("SELECT count(*) n FROM points_telegram_claims").get(),
    ).toEqual({ n: 0 });
  });

  test("Telegram's delivery of the code records the connection once, with both opt-ins gating display", async () => {
    const connected = await h.connect(ONE, { id: 777, username: "alice_tg" });
    expect(connected).toEqual({
      status: 200,
      body: { ok: true, handled: "connected" },
    });
    expect(h.sent.at(-1)).toEqual({
      url: `https://api.telegram.org/bot${BOT.botToken}/sendMessage`,
      body: {
        chat_id: "777",
        text: "Telegram connected to your Slop account. You can close this chat.",
      },
    });
    const me = await h.call("/telegram/me", { as: ONE });
    expect(me.body).toEqual({
      configured: true,
      account: {
        id: "777",
        username: "alice_tg",
        verifiedAt: START,
        public: 0,
      },
      flow: null,
    });
    expect(
      h.sqlite.query("SELECT count(*) n FROM points_telegram_flows").get(),
    ).toEqual({ n: 0 });
    // Replaying the consumed code does nothing.
    const replay = await h.webhook(h.startMessage(`/start ${"a".repeat(43)}`));
    expect(replay.body.handled).toBe("invalid");
    // Private by default: nothing shows to others until the member opts in.
    const profile = () => h.call(`/telegram/profile?actor=${ONE.actor}`);
    expect((await profile()).body).toBeNull();
    const people = async () =>
      (await h.call("/people")).body.people.find(
        (p: { actor: { id: string } }) => p.actor.id === ONE.actor,
      ).telegram;
    expect(await people()).toBeNull();
    expect(
      (
        await h.call("/telegram/visibility", {
          as: ONE,
          body: { public: true },
        })
      ).body,
    ).toEqual({ updated: true });
    expect((await profile()).body).toEqual({
      username: "alice_tg",
      verifiedAt: START,
    });
    expect(await people()).toEqual({ username: "alice_tg", verifiedAt: START });
    // A private membership hides the link again without touching the record.
    expect(
      (await h.call("/visibility", { as: ONE, body: { public: false } }))
        .status,
    ).toBe(200);
    expect((await profile()).body).toBeNull();
    expect(
      h.sqlite.query("SELECT public FROM points_telegram_links").get(),
    ).toEqual({ public: 1 });
  });

  test("a Telegram account stays with the first GitHub identity; reconnecting swaps the member's own link", async () => {
    expect((await h.connect(ONE, { id: 777 })).body.handled).toBe("connected");
    const taken = await h.connect(TWO, { id: 777 });
    expect(taken.body.handled).toBe("taken");
    expect(h.sent.at(-1)?.body.text).toContain(
      "already connected to another Slop account",
    );
    expect((await h.call("/telegram/me", { as: TWO })).body.account).toBeNull();
    expect((await h.call("/telegram/me", { as: ONE })).body.account.id).toBe(
      "777",
    );
    // Member one moves to a second Telegram account without a username.
    const moved = await h.webhook(
      h.startMessage(
        `/start ${h.codeOf((await h.call("/telegram/start", { as: ONE, body: { public: true } })).body.url)}`,
        { id: 888, username: undefined },
      ),
    );
    expect(moved.body.handled).toBe("connected");
    expect((await h.call("/telegram/me", { as: ONE })).body.account).toEqual({
      id: "888",
      username: null,
      verifiedAt: START,
      public: 1,
    });
    expect(
      h.sqlite
        .query(
          "SELECT telegram_id FROM points_telegram_claims ORDER BY telegram_id",
        )
        .all(),
    ).toEqual([{ telegram_id: "777" }, { telegram_id: "888" }]);
    // Disconnecting removes the link and keeps the reservation.
    expect(
      (await h.call("/telegram/disconnect", { as: ONE, body: {} })).body,
    ).toEqual({ disconnected: true });
    expect((await h.call("/telegram/me", { as: ONE })).body.account).toBeNull();
    expect(
      (
        await h.call("/telegram/visibility", {
          as: ONE,
          body: { public: true },
        })
      ).status,
    ).toBe(404);
    expect((await h.connect(TWO, { id: 777 })).body.handled).toBe("taken");
    expect(
      h.sqlite.query("SELECT count(*) n FROM points_telegram_claims").get(),
    ).toEqual({ n: 2 });
  });

  test("an expired code, a cancelled flow or a signed-out session never records a connection", async () => {
    const expired = await h.call("/telegram/start", {
      as: ONE,
      body: { public: false },
    });
    h.advance(10 * 60_000 + 1);
    expect(
      (await h.webhook(h.startMessage(`/start ${h.codeOf(expired.body.url)}`)))
        .body.handled,
    ).toBe("invalid");
    expect((await h.call("/telegram/me", { as: ONE })).body.flow).toBeNull();
    const cancelled = await h.call("/telegram/start", {
      as: ONE,
      body: { public: false },
    });
    expect(
      (await h.call("/telegram/cancel", { as: ONE, body: {} })).body,
    ).toEqual({ cancelled: true });
    expect(
      (
        await h.webhook(
          h.startMessage(`/start ${h.codeOf(cancelled.body.url)}`),
        )
      ).body.handled,
    ).toBe("invalid");
    const signedOut = await h.call("/telegram/start", {
      as: TWO,
      body: { public: false },
    });
    expect((await h.call("/signout", { as: TWO, body: {} })).status).toBe(200);
    expect(
      (
        await h.webhook(
          h.startMessage(`/start ${h.codeOf(signedOut.body.url)}`, { id: 999 }),
        )
      ).body.handled,
    ).toBe("invalid");
    expect(
      h.sqlite.query("SELECT count(*) n FROM points_telegram_claims").get(),
    ).toEqual({ n: 0 });
  });

  test("routes are closed when Telegram is not configured", async () => {
    const { db } = sqliteD1(migrations);
    const deps: PointsDependencies = {
      tier: "production",
      db: db as unknown as D1Database,
      rateLimitSecret: "r".repeat(48),
      identity: { fetch: async () => new Response(null, { status: 500 }) },
    };
    const webhook = await handlePointsApi(
      new Request(`${ORIGIN}/api/v1/points/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": BOT.webhookSecret,
        },
        body: "{}",
      }),
      deps,
    );
    expect(webhook.status).toBe(404);
  });
});
