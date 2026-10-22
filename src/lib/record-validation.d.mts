/** Strict record primitives shared by public record readers. */
export declare function isRecord(
  value: unknown,
): value is Record<string, unknown>;
export declare function readRecord(
  value: unknown,
  field: string,
): Record<string, unknown>;
export declare function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void;
export declare function timestamp(value: unknown, field: string): string;

export declare function nonNegativeInteger(
  value: unknown,
  path: string,
): number;
