import { describe, expect, it } from "vitest";
import {
  AUTO_POLICY_SECTION_KEYS,
  EMPTY_AUTO_POLICY_SECTIONS,
  joinAutoPolicySections,
  splitAutoPolicySections,
  unrepresentableSectionLine,
  type AutoPolicySectionKey,
} from "@/components/settings/panels/auto-policy-document";

type SectionOrNotes = AutoPolicySectionKey | "notes";

const EVERY_SECTION: ReadonlyArray<SectionOrNotes> = [
  ...AUTO_POLICY_SECTION_KEYS,
  "notes",
];

interface Case {
  readonly section: SectionOrNotes;
  readonly text: string;
  readonly expected: {
    readonly line: number;
    readonly topLevel: boolean;
    readonly namesSection: boolean;
  } | null;
}

const CASES: ReadonlyArray<Case> = [
  {
    section: "hardDeny",
    text: "# Production\nDeploying to production",
    expected: { line: 1, topLevel: true, namesSection: false },
  },
  {
    section: "hardDeny",
    text: "Deploying\n### Allow\nx",
    expected: { line: 2, topLevel: false, namesSection: true },
  },
  { section: "hardDeny", text: "## Production\nDeploying", expected: null },
  {
    section: "allow",
    text: "- a\n# Allow",
    expected: { line: 2, topLevel: true, namesSection: true },
  },
  {
    section: "notes",
    text: "## Allow\n- x",
    expected: { line: 1, topLevel: false, namesSection: true },
  },
  { section: "notes", text: "# Team policy\ntext", expected: null },
  {
    section: "hardDeny",
    text: "   # Production\nDeploying to production",
    expected: { line: 1, topLevel: true, namesSection: false },
  },
  {
    section: "hardDeny",
    text: "\n  ### Allow\nDeploying to production",
    expected: { line: 2, topLevel: false, namesSection: true },
  },
  {
    section: "notes",
    text: " \t## Allowed:\nDeploying to production",
    expected: { line: 1, topLevel: false, namesSection: true },
  },
  {
    section: "hardDeny",
    text: "\r\n\r\n  # X\nrule",
    expected: { line: 3, topLevel: true, namesSection: false },
  },
  {
    section: "hardDeny",
    text: "prefix\n   # Production\nDeploying to production",
    expected: null,
  },
  {
    section: "hardDeny",
    text: "   ## Production\nDeploying to production",
    expected: null,
  },
  { section: "notes", text: "   # Team policy\nNotes text", expected: null },
  { section: "hardDeny", text: "rule\n# ", expected: null },
];

const NAMING_TEXTS: ReadonlyArray<string> = [
  "## Soft block",
  "#### hard-deny",
  "## Allowed:",
  "## Environment",
  "## SoftDeny",
  "## hard block",
];

const NON_HEADINGS: ReadonlyArray<string> = ["#NoSpace", "####### seven"];

describe("unrepresentableSectionLine", () => {
  it.each(CASES)("$section: $text", ({ section, text, expected }) => {
    expect(unrepresentableSectionLine(section, text)).toEqual(expected);
  });

  it.each(NAMING_TEXTS)(
    "any section rejects %s as naming a section",
    (text) => {
      for (const section of EVERY_SECTION) {
        const found = unrepresentableSectionLine(section, text);
        expect(found?.namesSection).toBe(true);
        expect(found?.line).toBe(1);
      }
    },
  );

  it.each(NON_HEADINGS)("%s is not a heading, in any section", (text) => {
    for (const section of EVERY_SECTION) {
      expect(unrepresentableSectionLine(section, text)).toBeNull();
    }
  });

  it("counts lines in the text as typed, CRLF included", () => {
    for (const section of AUTO_POLICY_SECTION_KEYS) {
      expect(unrepresentableSectionLine(section, "a\r\n# B")?.line).toBe(2);
    }
  });
});

describe("unrepresentableSectionLine agrees with the real split", () => {
  const texts: ReadonlyArray<string> = [
    ...CASES.map((entry) => entry.text),
    ...NAMING_TEXTS,
    ...NON_HEADINGS,
    "a\r\n# B",
    "## Production\n### Deeper\nrule",
    "plain rule",
  ];

  for (const section of EVERY_SECTION) {
    for (const text of texts) {
      it(`${section}: ${JSON.stringify(text)}`, () => {
        // The split always writes LF; a CRLF line that stays in its section
        // has survived, so the comparison is by line, not by line ending.
        const survives =
          splitAutoPolicySections(
            joinAutoPolicySections({
              ...EMPTY_AUTO_POLICY_SECTIONS,
              [section]: text,
            }),
          )[section] === text.replace(/\r\n/g, "\n").trim();
        const rejected = unrepresentableSectionLine(section, text) !== null;
        expect(rejected).toBe(!survives);
      });
    }
  }
});
