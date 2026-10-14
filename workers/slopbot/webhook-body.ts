/**
 * Bounded webhook body reader. Signature verification must not allocate more
 * than the declared limit, and a missing Content-Length must not mean unbounded.
 */
export async function readWebhookBody(
  request: Request,
  maxBytes: number,
): Promise<
  { ok: true; body: string } | { ok: false; status: 400 | 413; message: string }
> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared) || Number(declared) > maxBytes) {
      return { ok: false, status: 413, message: "payload too large" };
    }
  }
  if (request.body === null) {
    return { ok: true, body: "" };
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("payload too large");
        } catch {
          // Bound breach is the actionable error.
        }
        return { ok: false, status: 413, message: "payload too large" };
      }
      try {
        body += decoder.decode(chunk.value, { stream: true });
      } catch (error) {
        if (error instanceof TypeError) {
          return {
            ok: false,
            status: 400,
            message: "invalid payload encoding",
          };
        }
        throw error;
      }
    }
    try {
      body += decoder.decode();
    } catch (error) {
      if (error instanceof TypeError) {
        return { ok: false, status: 400, message: "invalid payload encoding" };
      }
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, body };
}
