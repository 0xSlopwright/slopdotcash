import { afterEach, expect, spyOn, test } from "bun:test";
import { verifyStagingRoot } from "./verify-staging-root.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const headers = {
  "content-security-policy": "default-src 'self'",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
};

test("transient deployment propagation must recover to 200 with every header", async () => {
  let reads = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        _url: Parameters<typeof fetch>[0],
        options?: Parameters<typeof fetch>[1],
      ) => {
        expect(options?.redirect).toBe("manual");
        expect(options?.cache).toBe("no-store");
        return new Response(
          null,
          ++reads === 1 ? { status: 503 } : { status: 200, headers },
        );
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  await verifyStagingRoot("https://staging.slop.cash");
  expect(reads).toBe(2);
});

test("transport failure can recover but never becomes empty success", async () => {
  let reads = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        if (++reads === 1) throw new TypeError("synthetic connection reset");
        return new Response(null, { status: 200, headers });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  await verifyStagingRoot("https://staging.slop.cash");
  expect(reads).toBe(2);
});

test("permanent 404 and redirects fail immediately with status and origin", async () => {
  for (const status of [404, 302]) {
    let reads = 0;
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          reads++;
          return new Response(null, { status });
        },
        { preconnect: originalFetch.preconnect },
      ),
    );
    await expect(
      verifyStagingRoot("https://staging.slop.cash"),
    ).rejects.toThrow(`https://staging.slop.cash returned HTTP ${status}`);
    expect(reads).toBe(1);
  }
});

test("a 200 without security headers never qualifies, even after a transient read", async () => {
  let reads = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        new Response(null, ++reads === 1 ? { status: 502 } : { status: 200 }),
      { preconnect: originalFetch.preconnect },
    ),
  );
  await expect(verifyStagingRoot("https://staging.slop.cash")).rejects.toThrow(
    "omitted content-security-policy",
  );
  expect(reads).toBe(2);
});

test("persistent unavailability exhausts the bound and rejects", async () => {
  let reads = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        reads++;
        return new Response(null, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  await expect(verifyStagingRoot("https://staging.slop.cash")).rejects.toThrow(
    "retry bound",
  );
  expect(reads).toBe(6);
}, 10000);

test("every required security header remains mandatory", async () => {
  for (const header of Object.keys(headers)) {
    const missing = new Headers(headers);
    missing.delete(header);
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => new Response(null, { status: 200, headers: missing }),
        {
          preconnect: originalFetch.preconnect,
        },
      ),
    );
    await expect(
      verifyStagingRoot("https://staging.slop.cash"),
    ).rejects.toThrow(`omitted ${header}`);
  }
});
