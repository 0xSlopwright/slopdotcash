import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  rpcTokenMetadataReader,
  TokenMetadataError,
} from "../../backend/projects/token-metadata";
import {
  CLASSIC_TOKEN_PROGRAM,
  inspectMintAccount,
  inspectTokenAccount,
  TOKEN_2022_PROGRAM,
} from "./token";

const mint = "35fWL6pdJqpconRZPrawUAQegw1QF3p2tgN7mzhTpump";
const captured = new Uint8Array(
  readFileSync(
    new URL("./integration/fixtures/pmup-mint.bin", import.meta.url),
  ),
);
const account = (bytes: Uint8Array, owner = TOKEN_2022_PROGRAM) => ({
  owner,
  data: [Buffer.from(bytes).toString("base64"), "base64"],
});

test("the actual PMUP metadata mint is admitted without admitting active mint or freeze authority", () => {
  expect(inspectMintAccount(account(captured), mint).decimals).toBe(6);
  for (const offset of [0, 46]) {
    const changed = captured.slice();
    changed[offset] = 1;
    expect(() => inspectMintAccount(account(changed), mint)).toThrow();
  }
  // Classic USDC-style authorities remain valid under the existing asset policy.
  const classic = captured.slice(0, 82);
  classic[0] = 1;
  classic[46] = 1;
  expect(
    inspectMintAccount(account(classic, CLASSIC_TOKEN_PROGRAM), mint).decimals,
  ).toBe(6);
});

test("economic, hook, duplicate and unknown mint extensions cannot ride alongside allowed metadata", () => {
  for (const kind of [1, 14, 60000]) {
    const changed = captured.slice();
    new DataView(changed.buffer).setUint16(166, kind, true);
    expect(() => inspectMintAccount(account(changed), mint)).toThrow();
  }
  const duplicate = new Uint8Array(captured.length + 68);
  duplicate.set(captured);
  duplicate.set(captured.slice(166, 234), captured.length);
  expect(() => inspectMintAccount(account(duplicate), mint)).toThrow();
  for (const changed of [captured.slice(0, -1), captured.slice()]) {
    if (changed.length === captured.length) changed[270] ^= 1; // Metadata's bound mint.
    expect(() => inspectMintAccount(account(changed), mint)).toThrow();
  }
});

test("ImmutableOwner token accounts preserve program identity and refuse unrelated extensions", () => {
  const bytes = new Uint8Array(170);
  bytes[108] = 1;
  bytes[165] = 2;
  bytes[166] = 7;
  expect(inspectTokenAccount(account(bytes), TOKEN_2022_PROGRAM).bytes).toEqual(
    bytes,
  );
  expect(() =>
    inspectTokenAccount(account(bytes), CLASSIC_TOKEN_PROGRAM),
  ).toThrow();
  const memo = new Uint8Array(171);
  memo.set(bytes);
  memo[166] = 8;
  memo[168] = 1;
  expect(() =>
    inspectTokenAccount(account(memo), TOKEN_2022_PROGRAM),
  ).toThrow();
});

test("maintainer token submission admits PMUP from raw state but cannot hide a transfer hook in JSON parsing", async () => {
  let bytes = captured;
  const reader = rpcTokenMetadataReader(
    (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.method).toBe("getAccountInfo");
      expect(request.params).toEqual([
        mint,
        { encoding: "base64", commitment: "finalized" },
      ]);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { value: account(bytes) },
        }),
      );
    }) as typeof fetch,
    { solana: "https://fixture.invalid" },
  );
  expect(await reader("solana", mint)).toEqual({ decimals: 6, symbol: null });
  bytes = captured.slice();
  new DataView(bytes.buffer).setUint16(166, 14, true);
  await expect(reader("solana", mint)).rejects.toBeInstanceOf(
    TokenMetadataError,
  );
});
