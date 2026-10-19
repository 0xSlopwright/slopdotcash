/**
 * Renders a project's contributor and reviewer skills from the one generic
 * template pair and one project manifest revision. Rendering is pure and
 * deterministic: the same template commit, manifest revision and public origin
 * always give the same bytes, digest and archive. The Pages Function serves
 * the output; `scripts/render-project-skill.mjs` reproduces it offline.
 */

import { REWARD_ASSET_NETWORKS } from "./reward-asset.mjs";

export const GENERATED_SKILL_SCHEMA = "slop-generated-skill:v1";
export const TEMPLATE_REPOSITORY = "SlopDotCash/slopdotcash";
export const CONTRIBUTOR_TEMPLATE_PATH = "skills/contribute-to-project";
export const REVIEWER_TEMPLATE_PATH = "skills/review-project-contributions";
export const SKILL_KIT_PATH = "scripts/skill-kit";
/** Shared scripts every contributor archive carries for attribution. */
export const SKILL_KIT_FILES = Object.freeze([
  "live-report.mjs",
  "run-receipt.mjs",
  "skill-authority.d.mts",
  "skill-authority.mjs",
  "terms-preflight.mjs",
  "wallet-claim.mjs",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof bytes === "string" ? encoder.encode(bytes) : bytes,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Single-pass substitution, so maintainer text is never re-expanded. */
export function renderTemplate(source, values) {
  return source.replace(/\{\{([A-Za-z]+)\}\}/gu, (_, key) => {
    if (!Object.hasOwn(values, key))
      throw new TypeError(`Skill template uses unknown field ${key}`);
    return values[key];
  });
}

function frontmatterText(value) {
  // A JSON string is a valid YAML double-quoted scalar. Skill validators
  // refuse angle brackets in descriptions.
  return JSON.stringify(value.replace(/[<>]/gu, ""));
}

function currentRepository(repository) {
  return repository.aliases?.at(-1) ?? repository.id;
}

function rewardAssetText(manifest) {
  const asset = manifest.rewardAsset;
  if (asset === undefined) {
    return manifest.reward.currency && manifest.reward.chain
      ? `${manifest.reward.currency} on ${manifest.reward.chain}`
      : "No platform reward asset";
  }
  const network = REWARD_ASSET_NETWORKS[asset.network];
  return `${asset.symbol} (${asset.kind === "stablecoin" ? "network stablecoin" : "token"}) on ${network.name}, address \`${asset.address}\`, ${asset.decimals} decimals`;
}

function rewardSummary(manifest) {
  const reward = manifest.reward;
  if (reward.kind === "external-prize-share")
    return `This project shares an external prize (${reward.externalOpportunity?.name ?? "external opportunity"}). The organizer's rules decide eligibility, amount and payment. Slop publishes contribution shares only.`;
  const state =
    reward.fundingState === "committed"
      ? "committed funding"
      : "an unfunded pledge";
  return `Monthly pool target ${reward.monthlyCapDisplay}, ${state}. Payments are ${reward.paymentMode}. Reward asset: ${rewardAssetText(manifest)}. A target or a pledge is not a payment promise.`;
}

function templateValues(manifest, kind, revision, manifestSha256) {
  const content = manifest.skillContent;
  if (content === undefined)
    throw new TypeError(`Project ${manifest.id} has no skill content`);
  const repository = manifest.repositories[0];
  const repositoryPath = currentRepository(repository);
  const skillName =
    kind === "contributor" ? manifest.skill.id : manifest.reviewSkill.id;
  const name = manifest.name;
  const description =
    kind === "contributor"
      ? `Contributes accepted work to ${name} (${repositoryPath}) through Slop. Use to select bounded unblocked work in ${repositoryPath}, follow its maintainer rules, test the result and open one attributed pull request into ${repository.integrationBranch}.`
      : `Reviews exact-head pull requests into ${name} (${repositoryPath}) for scope, correctness, security and real evidence. Use on an existing pull request; excludes implementation, self-approval, scoring and payment decisions.`;
  const terms = manifest.terms;
  return {
    skillName,
    description: frontmatterText(description),
    projectId: manifest.id,
    projectName: name,
    projectDescription: manifest.description,
    projectStatus: manifest.status,
    projectRevision: String(revision),
    manifestSha256,
    repository: repositoryPath,
    repositoryUrl: repository.githubUrl,
    repositoryId: repository.id,
    integrationBranch: repository.integrationBranch,
    issuesUrl: manifest.links.issues,
    stewardName: manifest.steward.displayName,
    stewardLogin: manifest.steward.github.login,
    authorityState: manifest.authority.state,
    license:
      terms.repositoryLicense.state === "verified"
        ? `${terms.repositoryLicense.spdx} at \`${terms.repositoryLicense.commitSha}\``
        : "unknown",
    inboundTerms: terms.inbound.mode,
    rewardAsset: rewardAssetText(manifest),
    paymentMode: manifest.reward.paymentMode,
    rewardSummary: rewardSummary(manifest),
    scope: content.scope,
    contributionGuide: content.contributionGuide,
    supportedTasks: content.supportedTasks,
    requiredTests: content.requiredTests,
    reviewExpectations: content.reviewExpectations,
    securityContact: content.securityContact,
    closurePolicy: content.closurePolicy,
    notes: content.notes === "" ? "None." : content.notes,
  };
}

// --- Deterministic stored ZIP -------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds an uncompressed ZIP with sorted entries, a fixed 1980-01-01 time and
 * regular-file mode 0644, so equal inputs give equal bytes.
 */
export function storedZip(entries) {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, bytes } of sorted) {
    const name = encoder.encode(path);
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0x0021, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, bytes.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, (3 << 8) | 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x0021, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(38, (0o100644 << 16) >>> 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, bytes);
    centrals.push(central);
    offset += local.length + bytes.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, sorted.length, true);
  endView.setUint16(10, sorted.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const archive = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.length;
  }
  return archive;
}

// --- Rendering -----------------------------------------------------------

/**
 * @param template the published template index (commit, revision status and
 *   the file digests of both templates and the shared skill kit)
 * @param readFile resolves a repository path from the template index to bytes
 */
async function verifiedTemplateFiles(group, readFile) {
  const files = [];
  for (const file of group.files) {
    const bytes = await readFile(`${group.sourcePath}/${file.path}`);
    if ((await sha256Hex(bytes)) !== file.sha256)
      throw new Error(
        `Skill template file ${group.sourcePath}/${file.path} does not match its digest`,
      );
    files.push({ path: file.path, bytes });
  }
  return files;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function renderOne({
  kind,
  template,
  group,
  readFile,
  manifest,
  revision,
  manifestSha256,
  publicOrigin,
}) {
  const values = templateValues(manifest, kind, revision, manifestSha256);
  const sources = await verifiedTemplateFiles(group, readFile);
  const files = sources.map(({ path, bytes }) => ({
    path,
    bytes: path.endsWith(".md")
      ? encoder.encode(renderTemplate(decoder.decode(bytes), values))
      : bytes,
  }));
  const skillName = values.skillName;
  if (kind === "contributor") {
    for (const { path, bytes } of await verifiedTemplateFiles(
      template.scripts,
      readFile,
    ))
      files.push({ path: `scripts/${path}`, bytes });
    files.push({
      path: "project.json",
      bytes: encoder.encode(
        canonicalJson({
          schemaVersion: "1",
          projectId: manifest.id,
          repositoryId: manifest.repositories[0].id,
          skillName,
          skillSourcePath: CONTRIBUTOR_TEMPLATE_PATH,
          publicOrigin: `${publicOrigin}/projects/${manifest.id}`,
          policyAuthority: publicOrigin,
          usageAdapters: {
            codex: "codex",
            "claude-code": "claude",
            "grok-build": "grok",
          },
        }),
      ),
    });
  }
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const fileDigests = [];
  for (const file of files)
    fileDigests.push({ path: file.path, sha256: await sha256Hex(file.bytes) });
  const binding = {
    schema: GENERATED_SKILL_SCHEMA,
    name: skillName,
    projectId: manifest.id,
    projectRevision: revision,
    manifestSha256,
    template: {
      repository: TEMPLATE_REPOSITORY,
      commit: template.commit,
      sourcePath: group.sourcePath,
    },
    publicOrigin,
    files: fileDigests,
  };
  const digest = await sha256Hex(JSON.stringify(binding));
  const provenance = {
    schemaVersion: "1",
    kind: GENERATED_SKILL_SCHEMA,
    name: skillName,
    projectId: manifest.id,
    projectRevision: revision,
    manifestSha256,
    template: {
      repository: TEMPLATE_REPOSITORY,
      commit: template.commit,
      revisionStatus: template.revisionStatus,
      sourcePath: group.sourcePath,
      files: group.files,
      ...(kind === "contributor" ? { scripts: template.scripts } : {}),
    },
    publicOrigin,
    files: fileDigests,
    digest,
    skillRevision: `${TEMPLATE_REPOSITORY}@${template.commit}:${group.sourcePath}+${manifest.id}@${revision}#sha256:${digest}`,
  };
  const provenanceBytes = encoder.encode(canonicalJson(provenance));
  const archive = storedZip(
    [...files, { path: "PROVENANCE.json", bytes: provenanceBytes }].map(
      ({ path, bytes }) => ({ path: `${skillName}/${path}`, bytes }),
    ),
  );
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill)
    throw new Error(`Skill template ${group.sourcePath} has no SKILL.md`);
  return {
    name: skillName,
    files,
    provenance,
    provenanceBytes,
    skillMarkdown: skill.bytes,
    archive,
    archiveSha256: await sha256Hex(archive),
  };
}

/** True when a manifest carries what a generated skill needs. */
export function projectPublishesSkills(manifest) {
  return manifest.skillContent !== undefined;
}

export async function renderProjectSkills({
  template,
  readFile,
  manifest,
  revision,
  manifestSha256,
  publicOrigin,
}) {
  if (!/^[0-9a-f]{40}$/u.test(template.commit ?? ""))
    throw new TypeError("Skill template commit is not a full SHA");
  if (
    !/^https:\/\/[a-z0-9.-]+(?::\d+)?$|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(
      publicOrigin,
    )
  )
    throw new TypeError("Skill public origin is invalid");
  const shared = {
    template,
    readFile,
    manifest,
    revision,
    manifestSha256,
    publicOrigin,
  };
  return {
    contributor: await renderOne({
      ...shared,
      kind: "contributor",
      group: template.contributor,
    }),
    reviewer: await renderOne({
      ...shared,
      kind: "reviewer",
      group: template.reviewer,
    }),
  };
}

/** The public routing manifest for one rendered skill. */
export function skillManifest(rendered, { publicOrigin, projectId, review }) {
  const base = `${publicOrigin}/projects/${projectId}`;
  const prefix = review ? "review/" : "";
  return {
    schemaVersion: "1",
    kind: GENERATED_SKILL_SCHEMA,
    name: rendered.name,
    projectId,
    projectRevision: rendered.provenance.projectRevision,
    manifestSha256: rendered.provenance.manifestSha256,
    template: {
      repository: rendered.provenance.template.repository,
      commit: rendered.provenance.template.commit,
      revisionStatus: rendered.provenance.template.revisionStatus,
      sourcePath: rendered.provenance.template.sourcePath,
    },
    digest: rendered.provenance.digest,
    skillRevision: rendered.provenance.skillRevision,
    source: {
      publicUrl: `${base}/${prefix}SKILL.md`,
    },
    files: rendered.provenance.files,
    archive: {
      url: `${base}/downloads/${rendered.name}.skill`,
      sha256: rendered.archiveSha256,
      checksumUrl: `${base}/downloads/${rendered.name}.skill.sha256`,
    },
    revisions: `${publicOrigin}/api/v1/project-revisions`,
    policy:
      "Generated from the reviewed template at the named commit and the named manifest revision. Reproduce the bytes with scripts/render-project-skill.mjs at that commit. Maintainers decide acceptance, score and payment.",
  };
}
