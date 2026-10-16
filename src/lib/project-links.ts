import type { ProjectDefinition } from "./projects.mjs";

export type ProjectLink = { readonly href: string; readonly label: string };

const NAMED_LINK_LABELS: Readonly<Record<string, string>> = {
  creator: "Creator",
  discussions: "Discussions",
  issues: "Issues",
  repository: "GitHub",
};

function websiteLabel(href: string): string {
  const { hostname, pathname } = new URL(href);
  const host = hostname.replace(/^www\./u, "");
  const path = pathname.replace(/\/$/u, "");
  return path ? `${host}${path}` : host;
}

function namedLinkLabel(name: string, href: string): string {
  if (name === "website") return websiteLabel(href);
  if (name === "x") return `@${new URL(href).pathname.slice(1)} on X`;
  const known = NAMED_LINK_LABELS[name];
  if (known) return known;
  const words = name.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalized(href: string): string {
  const parsed = new URL(href);
  return `${parsed.origin}${parsed.pathname.replace(/\/$/u, "")}${parsed.search}`;
}

/**
 * Lists a project's public links in reading order: its website (the
 * steward's, then `links.website`), its X account, then the manifest's other
 * named links. Repeated URLs appear once. `links` sits outside the material
 * terms, so adding one needs no new terms revision.
 */
export function projectLinks(project: ProjectDefinition): ProjectLink[] {
  const links: ProjectLink[] = [];
  const seen = new Set<string>();
  const add = (href: string, label: string) => {
    const key = normalized(href);
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ href, label });
  };
  if (project.steward.website)
    add(project.steward.website, websiteLabel(project.steward.website));
  const { website, x, ...named } = project.links;
  if (website) add(website, namedLinkLabel("website", website));
  if (x) add(x, namedLinkLabel("x", x));
  for (const [name, href] of Object.entries(named))
    add(href, namedLinkLabel(name, href));
  return links;
}
