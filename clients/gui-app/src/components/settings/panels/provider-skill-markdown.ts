export const SKILL_ENTRY_FILE = "SKILL.md";

/** Anything else is body content and is returned untouched - a skill whose body legitimately opens with a
 * horizontal rule must not lose its first section. */
export function stripSkillFrontmatter(raw: string): string {
  return splitSkillMarkdown(raw).body;
}

export type ParsedSkillMarkdown = {
  readonly name: string | null;
  readonly description: string | null;
  readonly body: string;
};

/** Name + description from the leading YAML block, body via stripSkillFrontmatter. */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const split = splitSkillMarkdown(raw);
  if (split.frontmatter === null) {
    return { name: null, description: null, body: split.body };
  }
  return {
    name: yamlScalar(split.frontmatter, "name"),
    description: yamlScalar(split.frontmatter, "description"),
    body: split.body,
  };
}

function splitSkillMarkdown(raw: string): {
  readonly frontmatter: string | null;
  readonly body: string;
} {
  // Tolerate a UTF-8 BOM and CRLF; neither is exotic in a file a user may have
  // written on Windows, and both would otherwise defeat the open-fence match.
  const text = raw.replace(/^\uFEFF/, "");
  const opener = /^---[ \t]*\r?\n/.exec(text);
  if (opener === null) return { frontmatter: null, body: raw };
  const rest = text.slice(opener[0].length);
  const closer = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (closer === null) return { frontmatter: null, body: raw };
  return {
    frontmatter: rest.slice(0, closer.index),
    body: rest.slice(closer.index + closer[0].length).replace(/^\s*\r?\n/, ""),
  };
}

function yamlScalar(block: string, key: string): string | null {
  const match = new RegExp(`^${key}:[ \t]*(.*)$`, "m").exec(block);
  if (match === null) return null;
  const raw = match[1].trim();
  if (raw.length === 0) return null;
  // The row already carries the host's parsed description. Falling back to it
  // is safer than treating a YAML block-scalar marker as the description.
  if (raw.startsWith("|") || raw.startsWith(">")) return null;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : raw.slice(1, -1);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}
