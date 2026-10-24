/** Real signed Pages handler -> local Worker -> disposable container workflow. */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { CloudflareProjectPersistence } from "../../backend/projects/cloudflare-persistence";
import { sha256Hex } from "../../backend/trace/validation";
import {
  handleVettingApi,
  type VettingApiDependencies,
} from "../../backend/vetting/handler";
import { CloudflareVettingPersistence } from "../../backend/vetting/persistence";
import { sqliteD1 } from "../../tests/sqlite-d1";
import { signedServiceHeaders } from "../vetting/service";

const target = process.env.SLOP_SANDBOX_TEST_URL;
assert(
  target && /^http:\/\/127\.0\.0\.1:\d+$/.test(target),
  "Set a local Worker URL",
);
const keys = (await crypto.subtle.generateKey("Ed25519", true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const raw = new Uint8Array(
  await crypto.subtle.exportKey("raw", keys.publicKey),
);
const database = sqliteD1(
  readdirSync(new URL("../../migrations", import.meta.url))
    .filter((n) => n.endsWith(".sql"))
    .sort(),
);
let forwarded = 0;
const dependencies: VettingApiDependencies = {
  vetting: new CloudflareVettingPersistence(database.db, async () => false),
  projects: new CloudflareProjectPersistence(database.db),
  resultPublicKeys: btoa(String.fromCharCode(...raw)),
  now: () => new Date(),
  randomId: () => crypto.randomUUID(),
  session: async () => null,
  livePin: async () => {
    throw new Error("No project lookup belongs in isolated execution");
  },
  sandbox: {
    fetch: async (request) => {
      forwarded++;
      assert.equal(request.headers.has("authorization"), false);
      assert.equal(request.headers.has("cookie"), false);
      assert.equal(request.headers.has("x-slop-vetting-signature"), false);
      return fetch(`${target}${new URL(request.url).pathname}`, {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(request.method === "POST"
          ? { body: await request.arrayBuffer() }
          : {}),
      });
    },
  },
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) =>
    (await handleVettingApi(request, dependencies)) ??
    new Response("Not found", { status: 404 }),
});
const endpoint = `${server.url.origin}/api/v1/vetting/sandbox`;
const encoder = new TextEncoder();

async function payload(source: string, interpreter = "python") {
  const bytes = encoder.encode(source);
  return {
    artifactBase64: Buffer.from(bytes).toString("base64"),
    artifactSha256: await sha256Hex(bytes),
    interpreter,
  };
}
async function send(body: ReturnType<typeof encoder.encode>, signed = true) {
  return fetch(endpoint, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...(signed
        ? await signedServiceHeaders({
            signer: keys,
            method: "POST",
            pathAndQuery: "/api/v1/vetting/sandbox",
            body,
          })
        : {}),
    },
  });
}
type Evidence = {
  status: string;
  exitCode: number;
  stdoutBase64: string;
  outputComplete: boolean;
  internetEnabled: boolean;
};
async function execute(
  source: string,
  interpreter = "python",
): Promise<Evidence> {
  const response = await send(
    encoder.encode(JSON.stringify(await payload(source, interpreter))),
  );
  assert.equal(
    response.status,
    200,
    `Execution service returned ${response.status}`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const evidence = (await response.json()) as Evidence;
  assert.equal(evidence.internetEnabled, false);
  return evidence;
}
try {
  const body = encoder.encode(
    JSON.stringify(await payload("print('untrusted')")),
  );
  assert.equal((await send(body, false)).status, 401);
  assert.equal(forwarded, 0);
  const invalid = await payload("print('wrong digest')");
  invalid.artifactSha256 = "0".repeat(64);
  assert.equal(
    (await send(encoder.encode(JSON.stringify(invalid)))).status,
    400,
  );

  const identity = await execute(
    "import os,json\nprint(os.getuid(), os.getgid())\nprint(json.dumps(sorted(os.environ)))\nopen('/analysis/work/marker', 'w').write('private')",
  );
  assert.equal(identity.exitCode, 0);
  assert.match(
    Buffer.from(identity.stdoutBase64, "base64").toString(),
    /65534 65534/,
  );
  const environment = JSON.parse(
    Buffer.from(identity.stdoutBase64, "base64").toString().split("\n")[1],
  ) as string[];
  assert.deepEqual(
    environment.filter((key) => key !== "LC_CTYPE"),
    ["HOME", "PATH", "TMPDIR"],
  );
  const fresh = await execute(
    "import os\nprint(os.path.exists('/analysis/work/marker'))\nprint(os.getenv('SURPLUS_API_KEY', 'absent'))",
  );
  assert.equal(
    Buffer.from(fresh.stdoutBase64, "base64").toString(),
    "False\nabsent\n",
  );
  const node = await execute("console.log('node-runtime')", "node");
  assert.equal(node.exitCode, 0);
  assert.equal(
    Buffer.from(node.stdoutBase64, "base64").toString(),
    "node-runtime\n",
  );
  const network = await execute(
    "import socket\ntry:\n s=socket.socket()\n s.settimeout(3)\n s.connect(('1.1.1.1',443))\n print('CONNECTED')\nexcept OSError:\n print('BLOCKED')",
  );
  assert.equal(
    Buffer.from(network.stdoutBase64, "base64").toString(),
    "BLOCKED\n",
  );
  const limited = await execute("import sys\nsys.stdout.write('x' * 1000000)");
  assert.equal(limited.status, "output-limit");
  assert.equal(limited.outputComplete, false);
  assert.equal(Buffer.from(limited.stdoutBase64, "base64").length, 65536);
  const timeout = await execute("import time\ntime.sleep(40)");
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.outputComplete, false);
  console.log(
    "Signed isolation workflow passed: authorization, digest, identity, fresh filesystem, blocked network, output limit and timeout.",
  );
} finally {
  await server.stop(true);
  database.sqlite.close();
}
