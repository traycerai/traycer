import { describe, expect, it } from "vitest";
import {
  appendAutoPolicyLine,
  autoPolicyChangedSinceLoad,
  autoPolicyNeedsReorder,
  EMPTY_AUTO_POLICY_SECTIONS,
  joinAutoPolicySections,
  splitAutoPolicySections,
} from "@/components/settings/panels/auto-policy-document";
import canonicalDocuments from "./__fixtures__/auto-policy-canonical-documents.json";

describe("autoPolicyChangedSinceLoad", () => {
  it("timestamp -> null: stays false - `currentUpdatedAt: null` means 'cannot tell', not 'unset', and warning there would train the user to dismiss the warning that matters", () => {
    expect(autoPolicyChangedSinceLoad("A", null)).toBe(false);
  });

  it("null -> timestamp: true - the editor opened on no policy and another device has since CREATED one, so saving now would destroy a record this window never saw", () => {
    expect(autoPolicyChangedSinceLoad(null, "B")).toBe(true);
  });

  it("null -> null: false - nothing appeared", () => {
    expect(autoPolicyChangedSinceLoad(null, null)).toBe(false);
  });

  it("timestamp -> different timestamp: true - the ordinary stale-edit case", () => {
    expect(autoPolicyChangedSinceLoad("A", "B")).toBe(true);
  });

  it("timestamp -> same timestamp: false - nothing moved under the editor", () => {
    expect(autoPolicyChangedSinceLoad("A", "A")).toBe(false);
  });
});

describe("joinAutoPolicySections", () => {
  it("joins all-empty sections to the empty string", () => {
    expect(joinAutoPolicySections(EMPTY_AUTO_POLICY_SECTIONS)).toBe("");
  });

  it("writes Notes first, then the four headings in the judge's order", () => {
    expect(
      joinAutoPolicySections({
        environment: "env",
        allow: "a",
        softDeny: "s",
        hardDeny: "h",
        notes: "n",
      }),
    ).toBe(
      "n\n\n## Environment\n\nenv\n\n## Allow\n\na\n\n## Soft deny\n\ns\n\n## Hard deny\n\nh\n",
    );
  });

  it("writes every heading once anything is set, an empty section as a bare heading", () => {
    expect(
      joinAutoPolicySections({ ...EMPTY_AUTO_POLICY_SECTIONS, allow: "a" }),
    ).toBe("## Environment\n\n## Allow\n\na\n\n## Soft deny\n\n## Hard deny\n");
  });

  it("escalates every marker to # when a body carries a heading of depth <= 2", () => {
    const joined = joinAutoPolicySections({
      ...EMPTY_AUTO_POLICY_SECTIONS,
      allow: "## Deploy\n- x",
    });
    expect(joined).toContain("# Environment");
    expect(joined).toContain("# Allow");
    expect(joined).not.toContain("## Environment");
  });

  it("keeps ## markers for a body whose sub-heading is deeper than 2", () => {
    const joined = joinAutoPolicySections({
      ...EMPTY_AUTO_POLICY_SECTIONS,
      allow: "### Deploy\n- x",
    });
    expect(joined).toContain("## Allow");
  });

  it("ends with exactly one newline", () => {
    const joined = joinAutoPolicySections({
      ...EMPTY_AUTO_POLICY_SECTIONS,
      hardDeny: "h\n\n\n",
    });
    expect(joined.endsWith("\n")).toBe(true);
    expect(joined.endsWith("\n\n")).toBe(false);
  });
});

describe("splitAutoPolicySections", () => {
  it("accepts the host's heading synonyms", () => {
    const sections = splitAutoPolicySections(
      "## Allowed\na\n## Soft-Block\ns\n## HARD DENY:\nh\n## environment\ne",
    );
    expect(sections).toEqual({
      environment: "e",
      allow: "a",
      softDeny: "s",
      hardDeny: "h",
      notes: "",
    });
  });

  it("keeps a deeper sub-heading inside its section", () => {
    const sections = splitAutoPolicySections("## Allow\n- a\n### Deploy\n- b");
    expect(sections.allow).toBe("- a\n### Deploy\n- b");
    expect(sections.notes).toBe("");
  });

  it("files a same-depth heading that names no section, and what follows it, under notes", () => {
    const sections = splitAutoPolicySections(
      "## Allow\n- a\n## Other\ntext under other",
    );
    expect(sections.allow).toBe("- a");
    expect(sections.notes).toBe("## Other\ntext under other");
  });

  it("files text before the first heading under notes", () => {
    expect(splitAutoPolicySections("intro\n## Allow\n- a").notes).toBe("intro");
  });
});

describe("split/join idempotence", () => {
  const documents = [
    "",
    "just prose",
    "## Allow\n- a\n## Environment\ne",
    "notes\n## Hard deny\nh\n## Allow\n- a\n### Deploy\n- b",
    "# Allow\n- a\n## Deploy\n- b\n# Soft deny\ns",
  ];
  it.each(documents)("join(split(join(s))) === join(s) for %j", (document) => {
    const once = joinAutoPolicySections(splitAutoPolicySections(document));
    const twice = joinAutoPolicySections(splitAutoPolicySections(once));
    expect(twice).toBe(once);
  });
});

describe("autoPolicyNeedsReorder", () => {
  it("is false for an empty record", () => {
    expect(autoPolicyNeedsReorder("")).toBe(false);
  });

  it("is false for an already-canonical body", () => {
    const canonical = joinAutoPolicySections({
      ...EMPTY_AUTO_POLICY_SECTIONS,
      allow: "- a",
      hardDeny: "- h",
    });
    expect(autoPolicyNeedsReorder(canonical)).toBe(false);
  });

  it("is true for a reordered body", () => {
    expect(autoPolicyNeedsReorder("## Allow\n- a\n\n## Environment\ne")).toBe(
      true,
    );
  });

  it("is false for a body of blank lines, which a save clears rather than reorders", () => {
    expect(autoPolicyNeedsReorder("\n\n")).toBe(false);
  });
});

describe("appendAutoPolicyLine", () => {
  it("returns the line itself for an empty body", () => {
    expect(appendAutoPolicyLine("", "- new")).toBe("- new");
  });

  it("returns the line itself for a whitespace-only body", () => {
    expect(appendAutoPolicyLine("  \n\n", "- new")).toBe("- new");
  });

  it("strips trailing whitespace and newlines before adding newline + line", () => {
    expect(appendAutoPolicyLine("- a  \n\n\n", "- new")).toBe("- a\n- new");
  });
});

describe("canonical documents shared with the host", () => {
  it("carries at least the three documents the host also asserts", () => {
    expect(canonicalDocuments.length).toBeGreaterThanOrEqual(3);
  });

  it.each(canonicalDocuments)(
    "joins and splits $name exactly as the fixture says",
    ({ sections, markdown }) => {
      expect(joinAutoPolicySections(sections)).toBe(markdown);
      expect(splitAutoPolicySections(markdown)).toEqual(sections);
    },
  );
});
