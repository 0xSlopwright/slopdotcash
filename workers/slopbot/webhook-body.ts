/**
 * Bounded webhook body reader. Returns the exact received bytes so the HMAC
 * covers them unchanged, and a missing or false Content-Length never makes the
 * read unbounded. Returns null when the body exceeds maxBytes.
 */
export async function readWebhookBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    !(/^\d+$/u.test(declared) && Number(declared) <= maxBytes)
  ) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
