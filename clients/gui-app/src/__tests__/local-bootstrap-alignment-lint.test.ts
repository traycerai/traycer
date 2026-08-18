/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The local-bootstrap body presents ONE alignment, and this guard is what keeps
 * the classes that broke that from coming back.
 *
 * The defect: both bodies were fragments, so their children became direct
 * children of the window host modal's own `flex flex-col gap-4` column and each
 * one carried its own alignment or none. The details toggle carried
 * `self-center`, so it was the single centred element in a left-aligned card, and
 * `Configure shell…` sat in a `justify-center` wrapper of its own.
 *
 * WHY A GREP GUARD AND NOT A TEST. Alignment is a resolved box position and jsdom
 * computes no layout, so the only jsdom-visible form of the claim is an assertion
 * about the class string - which is exactly what this is, said honestly, rather
 * than dressed up as a behavioural test. The real measurement is
 * `scripts/window-host-modal-alignment-browser.mjs`, a headless-Chrome instrument
 * that is deliberately NOT in CI: it is an investigative microscope, and what
 * belongs in CI is the pin derived from what it showed. Ruled by the user.
 *
 * ⚠ WHAT THIS DOES NOT COVER, stated because "partial and known" is a different
 * claim from "we did what was cheap":
 *
 *  1. A PARENT LAYOUT CHANGE re-breaking alignment by another route - deleting
 *     the shell, or making it a row - trips no class here. That specific
 *     recurrence IS pinned, in jsdom, by the fragment mutations in
 *     `window-host-modal-host.test.tsx`; the original defect was structural
 *     rather than a class, and this guard would not have caught it. The two
 *     together are what make the gap acceptable rather than merely unaddressed.
 *  2. `self-start` + `justify-center`, which renders at the SAME left edge as the
 *     real fix because `self-start` shrink-wraps the control and leaves
 *     `justify-center` nothing to centre within. The browser instrument asserts
 *     its own blindness to that (`PC4`), and this guard is the thing that
 *     actually catches it - which is the main reason it exists.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The files whose alignment `LocalHostBodyShell` owns.
 *
 * Listed explicitly rather than globbed. The gate's own fallback card
 * (`host-readiness-controller.tsx`) is DELIBERATELY centred - it is the
 * `max-w-md` host-boot splash shape, which predates this work and must not
 * drift - so a glob over the host surfaces would flag a correct file and the
 * guard would be waived into uselessness on its first run.
 */
const BODY_FAMILY: readonly string[] = [
  "components/local-host-loading.tsx",
  "components/layout/dialogs/window-host-modal.tsx",
  "components/layout/dialogs/window-host-modal-host.tsx",
  "components/host/bootstrap-attempt-details.tsx",
];

/**
 * The LEFT-alignment utilities that would break this surface now.
 *
 * INVERTED, deliberately, and the history matters. This guard used to ban
 * CENTRING, because the body was left-aligned to sit under a dialog's own
 * left-aligned title and description. The healthy boot card has neither any
 * more - the user ruled against the titled dialog on rendered screenshots
 * ("the centered one was better looking") - so the body is centred, and the
 * classes that now produce a ragged card are the left-aligning ones.
 *
 * The MECHANISM is unchanged on purpose: same family, same waiver marker, same
 * positive controls. What flipped is which side of the axis is the offence.
 *
 * `items-start` is deliberately absent from the list for the same reason
 * `items-center` was absent before: on a ROW it is ordinary and correct (a
 * multi-line label beside a fixed-height control), and banning it would
 * produce a waiver on nearly every line and teach the next reader that the
 * marker is noise.
 */
const OFF_AXIS = /\bself-start\b|\bjustify-start\b|\btext-left\b/;

/**
 * Opt-out, which must carry a reason. Same shape and rationale as
 * `muted-fill-ok`: the exemption sits ON the line it excuses, beside the
 * evidence, instead of in a file-level list that silently widens.
 *
 * A legitimate reason names a ROW rather than the column - a control whose own
 * contents are centred within a fixed-size box (an icon in a square button) is
 * not competing with the card's alignment.
 *
 * ⚠ NOT a bare `\S`, and that was a real defect found by the reasonless-waiver
 * test below. With `\S`, a bare `{/* align-ok: *}` is HONOURED: the comment's own
 * closing `*` satisfies "some non-space character followed the colon". So the
 * mechanism designed to force a reason accepted a waiver with none, in the one
 * comment form used most often in JSX. The sibling `muted-fill-ok` marker had the
 * identical hole; it was closed in `a61df520`.
 *
 * ⚠⚠ Both markers were first fixed to `[A-Za-z]`, which OVERSHOT - a reason is
 * prose and may open with a digit or a slash (`/15 wash under its own border-b`
 * is a real one in this tree). Excluding the comment terminator is what was
 * actually needed; excluding everything that is not a letter also rejects
 * legitimate reasons, and the cheapest way green is to reword prose until a
 * regex likes it. Kept identical to the sibling's on purpose: two copies of one
 * mechanism are only useful as a cross-check while they agree.
 */
const ALLOW_MARKER = /align-ok:\s*(?!\*\/)\S/;

/** How many lines above an offence an annotation may sit and still cover it. */
const MARKER_LOOKBEHIND = 4;

/**
 * Prose about a class is not that class.
 *
 * Load-bearing here, not hygiene: `local-host-loading.tsx` DISCUSSES
 * `justify-center` at length - that is where the reason `self-start` is rejected
 * is recorded - so a guard that did not skip comments would flag its own
 * documentation and be deleted for crying wolf.
 */
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
   * THE POSITIVE CONTROL, and it is not optional.
   *
   * A sweep that finds nothing has made two claims - one about the tree and one
   * about itself - and only a planted violation separates them. This exact guard
   * family has already produced one FALSE ZERO on this branch (a lint sweep
   * reporting 0 violations across 1392 files because the rule was never live),
   * and it was a planted violation that caught it.
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

    // ...but a reason that does not begin with a LETTER is still a reason. The
    // first fix for the bare-marker hole was `[A-Za-z]`, which rejected this
    // shape - and the sibling guard has a real waiver in the tree that opens
    // with a slash. Pinned here so neither copy narrows back to the shape of
    // whatever reasons happen to exist today.
    const punctuationLed = [
      "  {/* align-ok: /2 of the log block, still left-to-right */}",
      '  <pre className="text-left font-mono" />',
    ].join("\n");
    expect(findOffAxis(punctuationLed, "punctuation.tsx")).toEqual([]);
  });
});

/**
 * F5: ONE HEADING PER EVENT - now enforced by there being only one heading to
 * begin with.
 *
 * HISTORY, because this pin inverted and the reason matters. The stage line
 * originally sat 2px below the dialog title at the IDENTICAL weight and colour,
 * so one event arrived as two competing headings; the fix DEMOTED the stage line
 * (`text-ui-sm text-muted-foreground`) and this guard pinned that demotion.
 *
 * The user then reported the whole stack - "Setting up Traycer" (dialog title),
 * "Setting up Traycer Host…" (stage line), "Setting up…" (the bar's short
 * label) - as one event said three times. Demoting the middle line had made the
 * duplication quieter, not absent. The startup presentation removes the other
 * two instead: `WindowHostStartupCard` draws NO title and NO description on a
 * healthy start, and the progress bar's label slot is bytes-or-nothing. That
 * leaves the stage line as the card's ONLY heading, so keeping it demoted would
 * now be the defect - a lone heading whispering in muted small type.
 *
 * So the guard flips: the stage line must be the PRIMARY line (the released
 * card's own `text-ui font-medium text-foreground`), and the duplication it was
 * defending against is pinned where it actually lives now - the count assertion
 * in `local-host-loading.test.tsx` ("Setting up" appears exactly once) and the
 * title/description absence in `window-host-modal-host.test.tsx`.
 */
describe("the host-boot stage line is the card's one heading", () => {
  // THE CLASSES MOVED, and the guard follows them rather than being deleted.
  // The stage line is now drawn by the SHARED boot headline
  // (`HostBootHeadline`), which is the whole point: the three boot surfaces a
  // launch crosses render one geometry instead of three, so there is exactly
  // one place left where this styling can regress.
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
    // The other half of "this alignment is bad" as reported: the spinner used
    // to be a separate child of the card's own column, so it sat at the LEFT
    // edge with the full column gap beneath it while the card around it was
    // centred. Owning both in one centred stack is what anchors the pair.
    const source = readFamilyFile("components/centered-card.tsx");
    const headline = source.slice(
      source.indexOf("export function HostBootHeadline"),
    );
    expect(headline).toContain("flex flex-col items-center gap-3");
  });
});
