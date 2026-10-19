/** Types for generated project skills. */

import type { ProjectDefinition } from "./projects.mjs";

export interface SkillTemplateGroup {
  readonly sourcePath: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

/** The template index prepare-site publishes at /skill-templates/index.json. */
export interface SkillTemplateIndex {
  readonly schemaVersion: "1";
  readonly repository: "SlopDotCash/slopdotcash";
  readonly commit: string;
  readonly revisionStatus: "committed" | "working-tree";
  readonly contributor: SkillTemplateGroup;
  readonly reviewer: SkillTemplateGroup;
  readonly scripts: SkillTemplateGroup;
}

export interface GeneratedSkillProvenance {
  readonly schemaVersion: "1";
  readonly kind: "slop-generated-skill:v1";
  readonly name: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly manifestSha256: string;
  readonly template: {
    readonly repository: string;
    readonly commit: string;
    readonly revisionStatus: "committed" | "working-tree";
    readonly sourcePath: string;
  };
  readonly publicOrigin: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly digest: string;
  readonly skillRevision: string;
}

export interface RenderedSkill {
  readonly name: string;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
  readonly provenance: GeneratedSkillProvenance;
  readonly provenanceBytes: Uint8Array;
  readonly skillMarkdown: Uint8Array;
  readonly archive: Uint8Array;
  readonly archiveSha256: string;
}

export declare const GENERATED_SKILL_SCHEMA: "slop-generated-skill:v1";
export declare const TEMPLATE_REPOSITORY: "SlopDotCash/slopdotcash";
export declare const CONTRIBUTOR_TEMPLATE_PATH: string;
export declare const REVIEWER_TEMPLATE_PATH: string;
export declare const SKILL_KIT_PATH: string;
export declare const SKILL_KIT_FILES: readonly string[];
export declare function sha256Hex(bytes: Uint8Array | string): Promise<string>;
export declare function renderTemplate(
  source: string,
  values: Readonly<Record<string, string>>,
): string;
export declare function storedZip(
  entries: readonly { path: string; bytes: Uint8Array }[],
): Uint8Array;
export declare function projectPublishesSkills(
  manifest: ProjectDefinition,
): boolean;
export declare function renderProjectSkills(input: {
  template: SkillTemplateIndex;
  readFile: (path: string) => Promise<Uint8Array>;
  manifest: ProjectDefinition;
  revision: number;
  manifestSha256: string;
  publicOrigin: string;
}): Promise<{ contributor: RenderedSkill; reviewer: RenderedSkill }>;
export declare function skillManifest(
  rendered: RenderedSkill,
  options: { publicOrigin: string; projectId: string; review: boolean },
): Record<string, unknown>;
