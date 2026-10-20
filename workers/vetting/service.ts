/** Shared private-service signing. This helper never sends or publishes a request. */
import { sha256Hex } from "../../backend/trace/validation";
import { vettingSignedMessage } from "../../backend/vetting/handler";

export type VettingServiceSigner = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};

export async function signedServiceHeaders(input: {
  signer: VettingServiceSigner;
  method: "GET" | "POST";
  pathAndQuery: string;
  body: Uint8Array;
  at?: Date;
}): Promise<Record<string, string>> {
  const path = new URL(input.pathAndQuery, "https://signer.invalid");
  if (
    path.origin !== "https://signer.invalid" ||
    `${path.pathname}${path.search}` !== input.pathAndQuery ||
    !path.pathname.startsWith("/api/v1/vetting/")
  )
    throw new Error("Invalid vetting service path");
  const timestamp = (input.at ?? new Date()).toISOString();
  const rawKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", input.signer.publicKey),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      input.signer.privateKey,
      vettingSignedMessage(
        input.method,
        input.pathAndQuery,
        timestamp,
        await sha256Hex(input.body),
      ) as Uint8Array<ArrayBuffer>,
    ),
  );
  return {
    "x-slop-vetting-key": await sha256Hex(rawKey),
    "x-slop-vetting-timestamp": timestamp,
    "x-slop-vetting-signature": btoa(String.fromCharCode(...signature)),
  };
}
