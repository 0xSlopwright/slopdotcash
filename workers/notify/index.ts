import { EmailMessage } from "cloudflare:email";
import type { SecurityD1Database } from "../../backend/security/handler";
import { readBoundedJson } from "../../src/lib/browser-json";
import { handleNotifyRequest } from "./handler";
import {
  dispatchSecurityMail,
  parseSecurityMailConfig,
  reconcileSecurityMail,
  type SecurityMailDependencies,
} from "./security";

type SendEmailBinding = {
  send(message: EmailMessage): Promise<void>;
};

type Env = {
  ADMIN_EMAIL: SendEmailBinding;
  ADMIN_EMAILS?: string;
  SLOP_DB?: SecurityD1Database;
  SECURITY_MAIL_PILOT?: string;
  NOTIFY_FROM_ADDRESS: string;
};

function securityDependencies(env: Env): SecurityMailDependencies | null {
  const config = parseSecurityMailConfig(env.SECURITY_MAIL_PILOT);
  if (!config || !env.SLOP_DB) return null;
  return {
    db: env.SLOP_DB,
    config,
    fromAddress: env.NOTIFY_FROM_ADDRESS,
    now: () => new Date(),
    sendEmail: (from, to, rawMime) =>
      env.ADMIN_EMAIL.send(new EmailMessage(from, to, rawMime)),
  };
}

export default {
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const deps = securityDependencies(env);
    if (deps) await dispatchSecurityMail(deps);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.origin === "https://notify.internal" &&
      [
        "/v1/security-notifications/dispatch",
        "/v1/security-notifications/reconcile",
      ].includes(url.pathname) &&
      !url.search
    ) {
      const respond = (status: number) =>
        new Response(null, {
          status,
          headers: { "cache-control": "private, no-store" },
        });
      if (request.method !== "POST") return respond(405);
      const deps = securityDependencies(env);
      if (!deps) return respond(503);
      try {
        const body = await readBoundedJson(
          request as unknown as Response,
          8192,
          "private notice",
        );
        if (typeof body !== "object" || body === null || Array.isArray(body))
          return respond(400);
        if (url.pathname.endsWith("/reconcile"))
          return respond(
            (await reconcileSecurityMail(deps, body as Record<string, unknown>))
              ? 204
              : 409,
          );
        if (Object.keys(body).length !== 0) return respond(400);
        await dispatchSecurityMail(deps);
        return respond(204);
      } catch {
        return respond(500);
      }
    }
    return handleNotifyRequest(request, {
      adminEmails: env.ADMIN_EMAILS,
      fromAddress: env.NOTIFY_FROM_ADDRESS,
      now: () => new Date(),
      randomId: () => crypto.randomUUID(),
      sendEmail: (from, to, rawMime) =>
        env.ADMIN_EMAIL.send(new EmailMessage(from, to, rawMime)),
    });
  },
};
