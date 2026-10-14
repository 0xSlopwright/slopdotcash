import { EmailMessage } from "cloudflare:email";
import { handleNotifyRequest } from "./handler";

type SendEmailBinding = {
  send(message: EmailMessage): Promise<void>;
};

type Env = {
  ADMIN_EMAIL: SendEmailBinding;
  ADMIN_EMAILS?: string;
  NOTIFY_FROM_ADDRESS: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
