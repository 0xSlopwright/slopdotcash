/**
 * Renders the direct install command for a generated project skill. It
 * downloads the archive, checks its SHA-256 against the routing manifest,
 * and replaces the installed copy atomically. It runs nothing it downloads.
 */

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createGeneratedSkillInstallCommand(
  projectOrigin: string,
  skillName: string,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell expands HOME.
  skillsRoot = "${HOME}/.agents/skills",
): string {
  if (!/^[a-z0-9-]{1,96}$/u.test(skillName))
    throw new TypeError("Invalid skill name");
  const url = new URL(projectOrigin);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1")
    throw new TypeError("Generated skills install only over HTTPS");
  const proto = url.protocol === "https:" ? "=https" : "=http";
  return `set -eu
ORIGIN=${shellQuote(projectOrigin.replace(/\/$/u, ""))}
NAME=${shellQuote(skillName)}
DEST="${skillsRoot}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fetch() { curl --fail --silent --show-error --proto '${proto}' --max-time 60 -o "$1" "$2"; }
fetch "$TMP/manifest.json" "$ORIGIN/skill-manifest.json"
fetch "$TMP/$NAME.skill" "$ORIGIN/downloads/$NAME.skill"
EXPECTED="$(python3 -c 'import json, sys
m = json.load(open(sys.argv[1]))
assert m["name"] == sys.argv[2] and m["kind"] == "slop-generated-skill:v1"
print(m["archive"]["sha256"])' "$TMP/manifest.json" "$NAME")"
ACTUAL="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$TMP/$NAME.skill")"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "Slop: archive SHA-256 does not match the manifest" >&2; exit 1; }
python3 -m zipfile -e "$TMP/$NAME.skill" "$TMP/unpacked"
[ -f "$TMP/unpacked/$NAME/SKILL.md" ] && [ -f "$TMP/unpacked/$NAME/PROVENANCE.json" ] || { echo "Slop: archive layout is invalid" >&2; exit 1; }
mkdir -p "$DEST"
rm -rf "$DEST/.$NAME.previous"
[ ! -e "$DEST/$NAME" ] || mv "$DEST/$NAME" "$DEST/.$NAME.previous"
mv "$TMP/unpacked/$NAME" "$DEST/$NAME"
echo "Slop: installed $NAME $ACTUAL into $DEST/$NAME"
`;
}
