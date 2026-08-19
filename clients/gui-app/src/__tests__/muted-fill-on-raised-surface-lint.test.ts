/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every preset theme's DARK variant defines `--muted` identical to
 * `--popover` and `--card`, and the flat light presets (github, gruvbox,
 * tokyo-night, nord, everforest) collapse it into `--background` too. Only
 * the default light/dark pair keeps the tokens apart - which is exactly why
 * a `bg-muted` fill on a raised surface looks correct in development and is
 * INVISIBLE for most users. It shipped that way once already (the usage
 * dialog's loading skeleton, a blank dialog body for every preset theme).
 *
 * The fix is an alpha of the foreground, which contrasts with whatever
 * surface it lands on by construction - see `clients/gui-app/AGENTS.md`.
 *
 * Scope: a file that paints a raised surface somewhere. Whether a given
 * `<div>` in it actually lands on that surface is not statically decidable,
 * so a fill that has been traced to a safe surface (`bg-canvas`, or inside
 * `.canvas-token-scope`, where `--background` remaps to `--canvas` and never
 * collapses) is kept by annotating it with {@link ALLOW_MARKER} and the
 * reason. That keeps the exemption ON the line it excuses, next to the
 * evidence, instead of in a file-level list that silently widens as the file
 * grows.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Markers that this file paints a `--popover`/`--card`-valued surface.
 *
 * The PRIMITIVES matter as much as the literal utility classes: a caller
 * that renders `<Card>`/`<CardContent>` creates a `--card` surface without
 * ever spelling `bg-card`, so matching only the class left the single most
 * common raised surface in the app unguarded. `<Card` covers the whole
 * family by prefix.
 *
 * `SettingsPanelShell` and `SettingsGroup` are named for the same reason
 * one level further out: both paint `bg-card/40` themselves, so a panel
 * that renders one is standing on a card without ever spelling it. Nearly
 * every settings surface in the app is one of those two.
 */
const RAISED_SURFACE =
  /DialogContent|AlertDialogContent|PopoverContent|HoverCardContent|DropdownMenuContent|SheetContent|ContextMenuContent|SelectContent|SettingsPanelShell|SettingsGroup|<Card|bg-popover|bg-card/;

/**
 * `bg-muted-foreground` is a TEXT color and is unaffected by the collapse.
 *
 * The raw `var(--muted)` forms matter as much as the utility: an inline
 * `style`, an arbitrary value (`bg-[color-mix(…var(--muted)…)]`) or a
 * gradient stop paints exactly the same collapsing color while spelling it
 * differently. Matching only `bg-muted` let those through. The `\)`
 * terminator keeps `var(--muted-foreground)` out.
 */
const MUTED_FILL =
  /bg-muted(?!-foreground)|var\(--muted\)|var\(--color-muted\)/;

/**
 * Opt-out for a fill that a collapse cannot actually erase. Must be followed
 * by a reason, which is one of exactly two claims:
 *
 * 1. The surface does not collapse - `bg-canvas`, or inside
 *    `.canvas-token-scope` where `--background` remaps to `--canvas`.
 * 2. The fill is not load-bearing - an explicit border delimits the element,
 *    or an interaction state has a second channel (a text-color swing,
 *    `line-through`), so a collapse degrades it instead of erasing it.
 *
 * Mind the comment form. In JSX CHILDREN position a `//` line is not a
 * comment at all - it is a text node, so it renders to the user and gives
 * any `asChild` ancestor a second child ("failed to slot onto its
 * children"). `tsc` accepts it either way, so only a render test catches it -
 * which is why {@link ALLOW_MARKER} annotations are parsed below rather than
 * trusted. Prefer attribute position (inside the opening tag), which is a
 * real comment in every context; `{@literal {}/* … *}` also works in children.
 *
 * ⚠ NOT a bare `\S`, and that was a live defect rather than a tightening. With
 * `\S`, a bare JSX-comment waiver is HONOURED: the comment's own closing `*` is a
 * non-space character following the colon, so the mechanism built to force a
 * reason accepted one with none - in the comment form JSX uses most, and across
 * all 46 waivers in the tree. Found by the sibling
 * `local-bootstrap-alignment-lint` guard, whose own reasonless-waiver arm caught
 * the identical hole in its copy of this marker.
 *
 * ⚠⚠ The first fix for that was `[A-Za-z]`, and it OVERSHOT. A reason is prose,
 * and prose does not have to begin with a letter: `shell-settings-panel.tsx:724`
 * carries `muted-fill-ok: /15 wash under its own border-b border-border/40` - a
 * perfectly good reason, silently NOT HONOURED, because it opens with a slash.
 * That was invisible only because `isLoadBearing` filters that fill before the
 * waiver is ever consulted; raise the alpha or drop the border and the guard
 * reddens on a line that already carries the reason it is demanding, and the
 * cheapest way green is to reword prose until a regex likes it.
 *
 * So the exclusion is the COMMENT TERMINATOR specifically, which is the only
 * thing that was ever masquerading as a reason - not "anything unlike a word".
 * ⇒ a validator tightened against one bad input should exclude THAT input, not
 * narrow to the shape of the examples that happened to be in the tree.
 */
const ALLOW_MARKER = /muted-fill-ok:\s*(?!\*\/)\S/;

/**
 * How many lines above a fill an annotation may sit and still cover it.
 *
 * ⚠ PROSE INSERTED BETWEEN A MARKER AND ITS CLASS LIST ORPHANS IT. That has
 * happened once for real: a commit added a paragraph explaining an unrelated
 * change above a waived fill, pushing the marker past this window.
 *
 * MEASURED, so nobody has to guess what catches it. Pushing a marker out of range
 * by five lines of prose:
 *
 *   in a file the sweep COVERS      -> BOTH tests redden. The fill reads as
 *     (paints a raised surface)        unannotated, and the marker as excusing
 *                                      nothing.
 *   in a file it does NOT cover     -> the stale-marker test alone reddens, which
 *                                      is still loud, and is what caught the real
 *                                      one.
 *
 * So the invariant is guarded in both directions and the failure is never silent.
 * Keep the marker LAST, adjacent to the class list it excuses, and put any
 * explanation above it rather than between.
 */
const MARKER_LOOKBEHIND = 4;

function collectTsxFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...collectTsxFiles(full));
      continue;
    }
    if (entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/** A comment line explaining the collapse is prose, not markup. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("{/*")
  );
}

/**
 * A fill behind a state prefix (`hover:`, `aria-expanded:`, `data-[…]:`).
 * For these the fill IS the entire state change, so the border test below
 * does not apply: a static border is drawn in both states and can signal
 * neither. Only another utility under a state prefix - a text-colour swing,
 * a ring - survives the collapse. Approximate by design: it does not check
 * that the two prefixes match, which keeps a `focus-visible:ring` from
 * excusing a `hover:` fill only by luck of them usually appearing together.
 */
const STATE_MUTED_FILL = /[a-z-]+(?:\[[^\]]*\])?:bg-muted/;
const STATE_OTHER_CHANNEL =
  /[a-z-]+(?:\[[^\]]*\])?:(?:text|border|ring|shadow|outline|opacity)-/;

/**
 * Whether a collapse would actually erase something here.
 *
 * A solid fill, or one at >= /40, carries the element's whole presence: lose
 * it and the element is gone. Below that the fill is a wash, and it only
 * matters when it is the ONLY thing delimiting the element - if the same
 * class list draws a border, a collapse degrades the element instead of
 * erasing it. That is the same line the audit drew (weak tints out of
 * scope), so encoding it here keeps the guard's output equal to its policy
 * instead of burying real defects under cosmetic ones.
 */
function isLoadBearing(line: string): boolean {
  if (STATE_MUTED_FILL.test(line)) return !STATE_OTHER_CHANNEL.test(line);
  if (/bg-muted(?![-/])|var\(--(?:color-)?muted\)/.test(line)) return true;
  const alphas = [...line.matchAll(/bg-muted\/(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  if (alphas.some((alpha) => alpha >= 40)) return true;
  return !/\bborder(?:-[a-z])?/.test(line);
}

/** Prose about a surface is not that surface - waivers name tokens too. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !isCommentLine(line))
    .join("\n");
}

/** Resolves `@/x` and `./x` to an absolute path; null for a package. */
function localSpecifierBase(specifier: string, from: string): string | null {
  if (specifier.startsWith("@/")) return path.join(SRC_DIR, specifier.slice(2));
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(from), specifier);
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Local `.tsx` modules a file imports, as absolute paths.
 *
 * Carries raised-surface context ONE hop into composed children: a reusable
 * leaf never spells `bg-popover` - its surface is whatever the caller
 * mounted it on - so a purely file-local scan calls it safe. Both of the
 * worst collapses in this changeset had that shape (the epic usage dialog's
 * share track, the agent stop list inside a `PopoverContent`).
 */
function importedLocalFiles(source: string, from: string): readonly string[] {
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
    (match) => match[1],
  );
  return specifiers.flatMap((specifier) => {
    const base = localSpecifierBase(specifier, from);
    if (base === null) return [];
    return [`${base}.tsx`, path.join(base, "index.tsx")].filter(isFile);
  });
}

/**
 * Files that paint a raised surface, plus the children they mount there.
 *
 * ONE hop, not the transitive closure: nearly every component is eventually
 * reachable from some dialog, so a full closure would mark the whole tree
 * raised and say nothing. The cost of that cut is real - the model picker's
 * capacity pill sits TWO hops from its `PopoverContent`
 * (`picker-panel` -> `picker-group` -> `picker-item`) and is invisible here,
 * so it was found and fixed by hand. A fill inside a component this scan
 * never reaches still needs the AGENTS.md rule applied by a human.
 *
 * ⚠ THE HOP COUNT IS NOT THE ONLY LIMIT, and reading it as one is misleading -
 * a whole shape of surface is unreachable at ANY depth. This scan follows
 * imports DOWNWARD from a file that spells a raised-surface token. When a
 * dialog's body is composed by its CALLER and passed in as a prop, that edge
 * runs the other way: the caller imports both the shell and the body, while
 * the shell - the thing nearest the actual `DialogContent` - imports neither.
 *
 * MEASURED, not reasoned: `components/local-host-loading.tsx` is the body of
 * the window host modal and renders inside a real dialog, and it is out of
 * scope at 1, 2 AND 3 hops (scope grows 387 -> 470 -> 519 of 823 files and
 * never includes it). Widening the radius does not reach it; only seeding from
 * the caller would, which is a different scan. It carries two `muted-fill-ok`
 * waivers today that nothing evaluates.
 *
 * ⇒ a waiver is a claim that a guard looked. In a file this scan cannot reach,
 * that claim is false, and it is more misleading than no annotation at all.
 */
function raisedSurfaceFiles(files: readonly string[]): ReadonlySet<string> {
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const raised = new Set(
    files.filter((f) =>
      RAISED_SURFACE.test(withoutComments(sources.get(f) ?? "")),
    ),
  );
  for (const file of [...raised]) {
    for (const dep of importedLocalFiles(sources.get(file) ?? "", file)) {
      raised.add(dep);
    }
  }
  return raised;
}

type Offence = { readonly location: string; readonly line: string };

function findUnannotatedFills(file: string, raised: ReadonlySet<string>) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  if (!raised.has(file)) return [];

  const offences: Offence[] = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (!MUTED_FILL.test(line)) return;
    if (!isLoadBearing(line)) return;
    const from = Math.max(0, index - MARKER_LOOKBEHIND);
    const covering = lines.slice(from, index + 1);
    if (covering.some((candidate) => ALLOW_MARKER.test(candidate))) return;
    const relative = path.relative(SRC_DIR, file).split(path.sep).join("/");
    offences.push({
      location: `${relative}:${String(index + 1)}`,
      line: line.trim(),
    });
  });
  return offences;
}

describe("muted fills on raised surfaces", () => {
  it("every muted fill in a file that paints a raised surface is fixed or justified", () => {
    const files = collectTsxFiles(SRC_DIR);
    const raised = raisedSurfaceFiles(files);
    const offences = files.flatMap((file) =>
      findUnannotatedFills(file, raised),
    );

    expect(offences.map((offence) => offence.location)).toEqual([]);
  });

  it("no annotation is left behind on a line that no longer has a fill", () => {
    const stale = collectTsxFiles(SRC_DIR).flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      const relative = path.relative(SRC_DIR, file).split(path.sep).join("/");
      return lines.flatMap((line, index) => {
        if (!ALLOW_MARKER.test(line)) return [];
        const covered = lines.slice(index, index + MARKER_LOOKBEHIND + 1);
        const excusesSomething = covered.some(
          (candidate) =>
            !isCommentLine(candidate) && MUTED_FILL.test(candidate),
        );
        return excusesSomething ? [] : [`${relative}:${String(index + 1)}`];
      });
    });

    expect(stale).toEqual([]);
  });

  /**
   * The annotations are prose about markup, so a malformed one is invisible
   * to `tsc` and silently becomes markup itself. Parsing is the only way to
   * tell the two apart: if the marker text lands in a `JsxText` node, the
   * "comment" is a rendered text node - it leaks internal notes into labels
   * ("Agents // muted-fill-ok: ...") and breaks any `asChild` ancestor by
   * handing Radix's Slot a second child. Five shipped that way before this
   * check existed.
   */
  it("a waiver with no reason excuses nothing", () => {
    // The marker's whole purpose is to force a REASON onto the line it excuses, so
    // a bare one must not count. Asserted against the pattern directly: this
    // file's detectors take file paths, and threading a string through them would
    // be a refactor in service of one assertion.
    //
    // Both bare forms that `\S` accepted - the JSX comment's closing `*`, and a
    // line comment with nothing after the colon:
    expect(ALLOW_MARKER.test("{/* muted-fill-ok: */}")).toBe(false);
    expect(ALLOW_MARKER.test("{/* muted-fill-ok:*/}")).toBe(false);
    expect(ALLOW_MARKER.test("// muted-fill-ok:")).toBe(false);

    // ...and a real reason still passes, in both comment forms. Without this half,
    // the assertions above would be satisfied by a pattern matching nothing at
    // all - which would silently un-waive all 46 existing annotations.
    expect(
      ALLOW_MARKER.test("// muted-fill-ok: weak tint delimited by its border"),
    ).toBe(true);
    expect(
      ALLOW_MARKER.test(
        "{/* muted-fill-ok: sits on bg-canvas, which cannot collapse */}",
      ),
    ).toBe(true);

    // A REASON IS PROSE AND NEED NOT START WITH A LETTER. The first fix for the
    // hole above was `[A-Za-z]`, which rejected these three - the first is a
    // real waiver in the tree (`shell-settings-panel.tsx:724`), un-honoured and
    // unnoticed because `isLoadBearing` filters its fill first. These arms are
    // what stop the next tightening from narrowing to whatever shape the current
    // waivers happen to have.
    expect(
      ALLOW_MARKER.test("// muted-fill-ok: /15 wash under its own border-b"),
    ).toBe(true);
    expect(ALLOW_MARKER.test("// muted-fill-ok: 40% over a bordered row")).toBe(
      true,
    );
    expect(
      ALLOW_MARKER.test(
        "{/* muted-fill-ok: --canvas remaps here, no collapse */}",
      ),
    ).toBe(true);
  });

  it("no annotation parses as JSX text instead of a comment", () => {
    const rendered = collectTsxFiles(SRC_DIR).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (!ALLOW_MARKER.test(source)) return [];
      const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const relative = path.relative(SRC_DIR, file).split(path.sep).join("/");
      const leaks: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isJsxText(node) && ALLOW_MARKER.test(node.getText())) {
          const { line } = parsed.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          leaks.push(`${relative}:${String(line + 1)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      return leaks;
    });

    expect(rendered).toEqual([]);
  });
});

describe("raised-surface primitives", () => {
  const readPrimitive = (file: string): string =>
    readFileSync(path.join(SRC_DIR, "components/ui", file), "utf8")
      .split("\n")
      .filter((line) => !isCommentLine(line))
      .join("\n");

  it.each([
    ["skeleton.tsx"],
    ["dialog.tsx"],
    ["card.tsx"],
    ["command.tsx"],
    ["button.tsx"],
    ["badge.tsx"],
    ["avatar.tsx"],
    ["kbd.tsx"],
    ["button-group.tsx"],
    ["confirm-destructive-dialog.tsx"],
    ["select-all-toggle.tsx"],
    ["tabs.tsx"],
  ])(
    "%s carries no muted fill - it is mounted on surfaces it cannot know",
    (file) => {
      expect(MUTED_FILL.test(readPrimitive(file))).toBe(false);
    },
  );

  it("Skeleton defaults to a surface-independent fill", () => {
    expect(readPrimitive("skeleton.tsx")).toContain("bg-foreground/10");
  });
});
