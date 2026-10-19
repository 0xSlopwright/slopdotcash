/** Types the project registry generator for focused contract tests. */

export function renderProjectRegistry(values: unknown): Promise<string>;
export function renderProjectRevisions(
  revisions: unknown,
  definitions: readonly unknown[],
): string;
export function fetchProjectRegistry(
  origin?: string,
): Promise<{ projects: unknown[]; revisions: unknown[] }>;
export function syncProjectRegistry(checkOnly?: boolean): Promise<boolean>;
