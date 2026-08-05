/** The file a skill directory is defined by, per the Agent Skills layout. */
export const SKILL_ENTRY_FILE = "SKILL.md";

/**
 * Drop a leading YAML frontmatter block from a SKILL.md.
 *
 * The host already parsed that block: `name` and `description` come back on
 * `ProviderSkill` and the dialog renders them in its header. Leaving the raw
 * block in the markdown body would print the same two fields a second time -
 * and worse, as a `<hr>`-delimited paragraph of `key: value` lines, since a
 * markdown renderer with no frontmatter plugin reads `---` as a thematic
 * break.
 *
 * Deliberately narrow: only a block that starts at byte 0, and only `---`
 * (not the `+++`/TOML variant, which the skill format does not use). Anything
 * else is body content and is returned untouched - a skill whose body legitimately
 * opens with a horizontal rule must not lose its first section.
 */
export function stripSkillFrontmatter(raw: string): string {
  // Tolerate a UTF-8 BOM and CRLF; neither is exotic in a file a user may have
  // written on Windows, and both would otherwise defeat the open-fence match.
  const text = raw.replace(/^\uFEFF/, "");
  const opener = /^---[ \t]*\r?\n/.exec(text);
  if (opener === null) return raw;
  const rest = text.slice(opener[0].length);
  const closer = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (closer === null) return raw;
  return rest.slice(closer.index + closer[0].length).replace(/^\s*\r?\n/, "");
}
