import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { onRequest } from "../functions/api/v1/[[path]]";

test("the checked-in staging configuration reaches payment authentication", async () => {
  const configuration = Bun.TOML.parse(
    readFileSync("wrangler.staging.toml", "utf8"),
  );
  // Anonymous payment requests must stop at authentication, before using bindings.
  const env = (
    configuration as { vars: Parameters<typeof onRequest>[0]["env"] }
  ).vars;
  const response = await onRequest({
    request: new Request("https://staging.slop.cash/api/v1/payments/me"),
    env,
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "not_signed_in" });

  const crossOrigin = await onRequest({
    request: new Request(
      "https://staging.slop.cash/api/v1/payments/wallets/register",
      {
        method: "POST",
        headers: {
          Origin: "https://slop.cash",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ),
    env,
  });
  expect(crossOrigin.status).toBe(403);
  expect(await crossOrigin.json()).toEqual({ error: "origin_forbidden" });
});
