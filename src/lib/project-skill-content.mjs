/**
 * Maintainer-authored content of a project's generated contributor and
 * reviewer skills. Slop renders it into the canonical skill templates under
 * `skills/contribute-to-project/` and `skills/review-project-contributions/`;
 * it never runs as code and never overrides the Slop rules in the template.
 */

/** Field order is the order of sections in the generated skills. */
export const SKILL_CONTENT_FIELDS = Object.freeze([
  Object.freeze({
    key: "scope",
    label: "Scope",
    hint: "What work is in scope for contributors, and what is not.",
    min: 40,
    max: 4000,
  }),
  Object.freeze({
    key: "contributionGuide",
    label: "Contribution guide",
    hint: "How to set up, branch, build and open a pull request in this repository.",
    min: 40,
    max: 8000,
  }),
  Object.freeze({
    key: "supportedTasks",
    label: "Supported tasks",
    hint: "The kinds of task an agent may select, for example reproduced bugs or listed issues.",
    min: 10,
    max: 4000,
  }),
  Object.freeze({
    key: "requiredTests",
    label: "Required tests",
    hint: "The exact commands and evidence every pull request must include.",
    min: 10,
    max: 4000,
  }),
  Object.freeze({
    key: "reviewExpectations",
    label: "Review expectations",
    hint: "What a reviewer must check before it recommends acceptance.",
    min: 20,
    max: 4000,
  }),
  Object.freeze({
    key: "securityContact",
    label: "Security contact",
    hint: "Where to report a vulnerability privately: an email address or an https URL.",
    min: 3,
    max: 300,
  }),
  Object.freeze({
    key: "closurePolicy",
    label: "Closure policy",
    hint: "When maintainers close a pull request without merging it.",
    min: 10,
    max: 2000,
  }),
  Object.freeze({
    key: "notes",
    label: "Notes",
    hint: "Optional. Anything else contributors must know.",
    min: 0,
    max: 4000,
  }),
]);

export const SKILL_CONTENT_KEYS = Object.freeze(
  SKILL_CONTENT_FIELDS.map((field) => field.key).sort(),
);

// Tabs and newlines only; no carriage returns, NUL or other control bytes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule rejects them.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/u;

/** Returns an error message for one field, or null when it is valid. */
export function skillContentFieldError(field, value) {
  if (typeof value !== "string") return `${field.label} must be text`;
  if (value !== value.trim())
    return `${field.label} must not start or end with whitespace`;
  if (CONTROL.test(value)) return `${field.label} contains a control character`;
  if (value.length < field.min || value.length > field.max)
    return field.min === 0
      ? `${field.label} must be at most ${field.max} characters`
      : `${field.label} must be ${field.min} to ${field.max} characters`;
  return null;
}

/** Validates a complete skill content record. Throws a TypeError. */
export function assertSkillContent(value, path = "project.skillContent") {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  if (Object.keys(value).sort().join("\0") !== SKILL_CONTENT_KEYS.join("\0"))
    throw new TypeError(`${path} has unexpected or missing fields`);
  for (const field of SKILL_CONTENT_FIELDS) {
    const error = skillContentFieldError(field, value[field.key]);
    if (error) throw new TypeError(`${path}.${field.key}: ${error}`);
  }
  return value;
}

/** Trims every field the way the API stores it. */
export function normalizeSkillContent(value) {
  return Object.fromEntries(
    SKILL_CONTENT_FIELDS.map((field) => [
      field.key,
      String(value?.[field.key] ?? "")
        .replaceAll("\r\n", "\n")
        .trim(),
    ]),
  );
}
