import { describe, expect, it } from "vitest";
import {
  hasShippedAutoPolicySections,
  parseShippedAutoPolicy,
} from "@/components/settings/panels/auto-policy-shipped-document";

// An inline fixture, not the host's real `defaults.md` - the OSS repo cannot
// depend on the internal one, and a fixture written here is also what proves
// the parser rather than something that happens to already be well-formed.
const DOCUMENT = `# Traycer's shipped judge policy

## Allow exceptions

- Read any file already in the workspace.
- Run read-only git commands.

## Soft block

- Delete a file outside the workspace.

### Notes for the judge

Ask before deleting anything you did not just create.

## Hard block (non-overridable)

- Force-push to a shared branch.

\`\`\`bash
# this looks like a heading but is code
echo hi
\`\`\`

- Exfiltrate credentials.

## Out of scope

Irrelevant-but-not-blocked work is not this judge's job.
`;

describe("parseShippedAutoPolicy", () => {
  it("slices each tier's body at the next heading, without leaking into a neighbour", () => {
    const sections = parseShippedAutoPolicy(DOCUMENT);

    expect(sections.allowExceptions).toContain(
      "Read any file already in the workspace.",
    );
    expect(sections.allowExceptions).not.toContain(
      "Delete a file outside the workspace.",
    );

    expect(sections.softBlock).toContain(
      "Delete a file outside the workspace.",
    );
    expect(sections.softBlock).not.toContain("Force-push to a shared branch.");

    expect(sections.hardBlock).toContain("Force-push to a shared branch.");
    expect(sections.hardBlock).not.toContain("Irrelevant-but-not-blocked work");
  });

  it("keeps a `###` subsection inside its `##` parent's body rather than terminating it", () => {
    const sections = parseShippedAutoPolicy(DOCUMENT);

    expect(sections.softBlock).toContain("Notes for the judge");
    expect(sections.softBlock).toContain(
      "Ask before deleting anything you did not just create.",
    );
  });

  it("returns an empty string for a section the document does not have", () => {
    const sections = parseShippedAutoPolicy(
      "## Allow exceptions\n\n- Only this tier exists.\n",
    );

    expect(sections.allowExceptions).toContain("Only this tier exists.");
    expect(sections.softBlock).toBe("");
    expect(sections.hardBlock).toBe("");
  });

  it("tolerates the hard block heading's parenthetical - the match is on the opening words", () => {
    const sections = parseShippedAutoPolicy(
      "## Hard block (non-overridable)\n\n- Never do this.\n",
    );

    expect(sections.hardBlock).toContain("Never do this.");
  });

  it("does not treat a `#` line inside a fenced code block as a heading", () => {
    const sections = parseShippedAutoPolicy(DOCUMENT);

    // If the fence were not tracked, the `#` comment line inside it would
    // parse as a heading and cut the hard-block section in half right there,
    // dropping everything from "echo hi" onward - including the real next
    // bullet - out of the section.
    expect(sections.hardBlock).toContain("echo hi");
    expect(sections.hardBlock).toContain(
      "this looks like a heading but is code",
    );
    expect(sections.hardBlock).toContain("Exfiltrate credentials.");
  });
});

describe("hasShippedAutoPolicySections", () => {
  it("is false for an empty document", () => {
    expect(hasShippedAutoPolicySections(parseShippedAutoPolicy(""))).toBe(
      false,
    );
  });

  it("is false for a document with none of the three tier headings", () => {
    const sections = parseShippedAutoPolicy(
      "# Some other document\n\n## Unrelated heading\n\nNothing here matches a tier.\n",
    );

    expect(hasShippedAutoPolicySections(sections)).toBe(false);
  });

  it("is true once at least one tier has a body", () => {
    const sections = parseShippedAutoPolicy(
      "## Allow exceptions\n\n- Something allowed.\n",
    );

    expect(hasShippedAutoPolicySections(sections)).toBe(true);
  });
});
