import { describe, expect, it } from "vitest";
import { stripSkillFrontmatter } from "@/components/settings/panels/provider-skill-markdown";

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
