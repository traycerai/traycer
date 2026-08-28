import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  stripSkillFrontmatter,
} from "@/components/settings/panels/provider-skill-markdown";

describe("stripSkillFrontmatter", () => {
  it("removes the leading frontmatter block the dialog header already shows", () => {
    const raw = '---\nname: find-skills\ndescription: "Finds"\n---\n\n# Body\n';
    expect(stripSkillFrontmatter(raw)).toBe("# Body\n");
  });

  it("keeps a body that merely opens with a horizontal rule", () => {
    // `---` followed by prose is a thematic break, not an unterminated
    // frontmatter block. Losing it would delete the skill's first section.
    const raw = "---\n\nSome instructions.\n";
    expect(stripSkillFrontmatter(raw)).toBe(raw);
  });

  it("returns the input untouched when there is no frontmatter at all", () => {
    const raw = "# Just a heading\n\nBody text.\n";
    expect(stripSkillFrontmatter(raw)).toBe(raw);
  });

  it("returns the input untouched when the block is never closed", () => {
    const raw = "---\nname: broken\ndescription: no terminator\n";
    expect(stripSkillFrontmatter(raw)).toBe(raw);
  });

  it("handles CRLF and a UTF-8 BOM", () => {
    const raw = "﻿---\r\nname: x\r\n---\r\n\r\nBody\r\n";
    expect(stripSkillFrontmatter(raw)).toBe("Body\r\n");
  });

  it("does not treat a `---` inside the body as a second opener", () => {
    const raw = "---\nname: x\n---\n\nOne\n\n---\n\nTwo\n";
    expect(stripSkillFrontmatter(raw)).toBe("One\n\n---\n\nTwo\n");
  });

  it("yields an empty body for a skill that is frontmatter only", () => {
    expect(stripSkillFrontmatter("---\nname: x\n---\n")).toBe("");
  });
});

describe("parseSkillMarkdown", () => {
  it("unquotes a JSON-quoted description", () => {
    const raw =
      '---\nname: find-skills\ndescription: "Helps users \\"discover\\" skills."\n---\n\n# Body\n';
    expect(parseSkillMarkdown(raw)).toEqual({
      name: "find-skills",
      description: 'Helps users "discover" skills.',
      body: "# Body\n",
    });
  });

  it("returns null name/description and the raw body when frontmatter is missing", () => {
    const raw = "# Just a heading\n\nBody text.\n";
    expect(parseSkillMarkdown(raw)).toEqual({
      name: null,
      description: null,
      body: raw,
    });
  });

  it("returns the body after stripSkillFrontmatter", () => {
    const raw =
      '---\nname: find-skills\ndescription: "Helps"\n---\n\n# When to use\n';
    const parsed = parseSkillMarkdown(raw);
    expect(parsed.body).toBe(stripSkillFrontmatter(raw));
    expect(parsed.body).toBe("# When to use\n");
    expect(parsed.body).not.toContain("description:");
  });

  it("returns a null description for YAML block-scalar markers", () => {
    expect(
      parseSkillMarkdown(
        "---\nname: find-skills\ndescription: |\n  Multi\n  line\n---\n\n# Body\n",
      ),
    ).toEqual({
      name: "find-skills",
      description: null,
      body: "# Body\n",
    });
    expect(
      parseSkillMarkdown(
        "---\nname: find-skills\ndescription: >\n  Folded\n  text\n---\n\n# Body\n",
      ),
    ).toEqual({
      name: "find-skills",
      description: null,
      body: "# Body\n",
    });
  });
});
