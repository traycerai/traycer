/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Guard the local-bootstrap body's one alignment. jsdom computes no layout, so this pins the class string. Catches `self-start` + `justify-center`, which the browser instrument cannot see. */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files whose alignment `LocalHostBodyShell` owns. Listed explicitly rather than globbed. */
const BODY_FAMILY: readonly string[] = [
  "components/local-host-loading.tsx",
  "components/layout/dialogs/window-host-modal.tsx",
  "components/layout/dialogs/window-host-modal-host.tsx",
  "components/host/bootstrap-attempt-details.tsx",
];

/** Left-alignment utilities that would break this now-centred body. `items-start` is absent: on a row it is ordinary. */
const OFF_AXIS = /\bself-start\b|\bjustify-start\b|\btext-left\b/;

/** align-ok: waiver must carry a reason. Exclude the comment terminator, not "anything unlike a word". */
const ALLOW_MARKER = /align-ok:\s*(?!\*\/)\S/;

/** How many lines above an offence an annotation may sit and still cover it. */
const MARKER_LOOKBEHIND = 4;

/** Prose about a class is not that class. `local-host-loading.tsx` discusses `justify-center` in comments. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("{/*")
  );
}

interface Offence {
  readonly location: string;
  readonly line: string;
}

/** Every unannotated centring utility in `source`, as `label:line` strings. */
function findOffAxis(source: string, label: string): readonly Offence[] {
  const lines = source.split("\n");
  return lines.flatMap((line, index) => {
    if (isCommentLine(line) || !OFF_AXIS.test(line)) return [];
    const window = lines.slice(
      Math.max(0, index - MARKER_LOOKBEHIND),
      index + 1,
    );
    if (window.some((candidate) => ALLOW_MARKER.test(candidate))) return [];
    return [{ location: `${label}:${String(index + 1)}`, line: line.trim() }];
  });
}

function readFamilyFile(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), "utf8");
}

describe("the local-bootstrap body's one alignment", () => {
  it("carries no LEFT-aligning utility anywhere in the body family", () => {
    const offences = BODY_FAMILY.flatMap((relative) =>
      findOffAxis(readFamilyFile(relative), relative),
    );

    expect(offences.map((offence) => offence.location)).toEqual([]);
  });

  /**
   * Planted violation: an empty offender list is indistinguishable from a dead matcher.
   */
  it.each([
    ["self-start", '  <button className="inline-flex self-start gap-1" />'],
    [
      "justify-start",
      '  <div className="flex w-full justify-start">{action}</div>',
    ],
    ["text-left", '  <p className="text-left text-ui-xs">Waiting…</p>'],
  ])("flags a planted %s", (_label, planted) => {
    expect(findOffAxis(planted, "planted.tsx")).toHaveLength(1);
  });

  it("does NOT flag items-start, which is correct on a row", () => {
    // The negative half of the control: a guard that flagged this would be
    // waived onto nearly every line in the family and stop meaning anything.
    const row = '  <div className="flex items-start justify-between" />';
    expect(findOffAxis(row, "row.tsx")).toEqual([]);
  });

  it("does NOT flag a comment that discusses the banned classes", () => {
    // `local-host-loading.tsx` really does contain these words in prose - it is
    // where the `self-start` rejection is explained - so this is a live
    // requirement, not a hypothetical.
    const prose = "  // NOT `self-start` here: alignment is the shell's.";
    expect(findOffAxis(prose, "prose.tsx")).toEqual([]);
  });

  it("honours an align-ok annotation, and only with a reason", () => {
    const excused = [
      "  {/* align-ok: a log block reads left-to-right whatever the card does */}",
      '  <pre className="text-left font-mono" />',
    ].join("\n");
    expect(findOffAxis(excused, "excused.tsx")).toEqual([]);

    // A bare marker with no reason must NOT excuse anything: an unexplained
    // waiver is the file-level allowlist this mechanism exists to avoid.
    const bare = [
      "  {/* align-ok: */}",
      '  <pre className="text-left font-mono" />',
    ].join("\n");
    expect(findOffAxis(bare, "bare.tsx")).toHaveLength(1);

    // Reason need not start with a letter; [A-Za-z] rejected a real slash-led
    // waiver. Do not tighten to current waiver shapes.
    const punctuationLed = [
      "  {/* align-ok: /2 of the log block, still left-to-right */}",
      '  <pre className="text-left font-mono" />',
    ].join("\n");
    expect(findOffAxis(punctuationLed, "punctuation.tsx")).toEqual([]);
  });
});

/** Stage line is the card's only heading and must stay the primary line (`text-ui font-medium text-foreground`). Duplication is pinned in `local-host-loading.test.tsx` and `window-host-modal-host.test.tsx`. */
describe("the host-boot stage line is the card's one heading", () => {
  // Stage line lives on HostBootHeadline, the one geometry all three boot
  // surfaces share. Guard follows the class there.
  const HEADLINE_TESTID = "data-testid={props.messageTestId}";

  function stageElementLines(): readonly string[] {
    const lines = readFamilyFile("components/centered-card.tsx").split("\n");
    const anchor = lines.findIndex((line) => line.includes(HEADLINE_TESTID));
    // Existence first: every assertion below is about this element, so a rename
    // that lost the testid would make them all pass against nothing.
    expect(anchor).toBeGreaterThan(-1);
    return lines.slice(anchor, anchor + 4);
  }

  it("is foreground, not muted - it is the heading now, not a caption", () => {
    const element = stageElementLines().join("\n");
    expect(/\btext-foreground\b/.test(element)).toBe(true);
    expect(element).not.toContain("text-muted-foreground");
  });

  it("carries the released card's heading size and weight", () => {
    const element = stageElementLines().join("\n");
    // `text-ui`, not `text-ui-sm`: the demotion existed only to sit under a
    // dialog title that no longer renders on this arm.
    expect(/\btext-ui\b(?!-)/.test(element)).toBe(true);
    expect(element).toContain("font-medium");
  });

  it("keeps the spinner and its label in ONE centred stack", () => {
    // Spinner and card share one centred stack. A separate spinner child sat
    // at the column's left edge.
    const source = readFamilyFile("components/centered-card.tsx");
    const headline = source.slice(
      source.indexOf("export function HostBootHeadline"),
    );
    expect(headline).toContain("flex flex-col items-center gap-3");
  });
});
