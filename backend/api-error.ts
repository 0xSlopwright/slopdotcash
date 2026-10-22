/** Expected request refusals; each API retains its own response and log policy. */
export type ApiError = Error & { status?: number; code?: string };
export function fail(status: number, code: string, message: string): never {
  const error: ApiError = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
