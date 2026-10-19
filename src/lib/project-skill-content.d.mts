/** Types for maintainer-authored generated-skill content. */

export type SkillContentKey =
  | "scope"
  | "contributionGuide"
  | "supportedTasks"
  | "requiredTests"
  | "reviewExpectations"
  | "securityContact"
  | "closurePolicy"
  | "notes";

export interface SkillContentField {
  readonly key: SkillContentKey;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
}

export type ProjectSkillContent = Readonly<Record<SkillContentKey, string>>;

export declare const SKILL_CONTENT_FIELDS: readonly SkillContentField[];
export declare const SKILL_CONTENT_KEYS: readonly SkillContentKey[];
export declare function skillContentFieldError(
  field: SkillContentField,
  value: unknown,
): string | null;
export declare function assertSkillContent(
  value: unknown,
  path?: string,
): ProjectSkillContent;
export declare function normalizeSkillContent(
  value: unknown,
): Record<SkillContentKey, string>;
