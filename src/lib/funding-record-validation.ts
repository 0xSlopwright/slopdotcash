/** Shared strict primitives for direct and committed funding records. */
export function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
) {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`${field} has unexpected or missing fields`);
  }
}

export function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

export function canonicalMinor(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^(?:0|[1-9]\d*)$/u.test(value)
  ) {
    throw new TypeError(`${field} must be canonical integer minor units`);
  }
  if (BigInt(value) === 0n) throw new TypeError(`${field} must be positive`);
  return value;
}
