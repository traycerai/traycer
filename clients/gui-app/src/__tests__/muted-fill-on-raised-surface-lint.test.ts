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
 */
const RAISED_SURFACE =
  /DialogContent|AlertDialogContent|PopoverContent|HoverCardContent|DropdownMenuContent|SheetContent|ContextMenuContent|SelectContent|<Card|bg-popover|bg-card/;

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
 */
const ALLOW_MARKER = /muted-fill-ok:\s*\S/;

/** How many lines above a fill an annotation may sit and still cover it. */
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

/**
 * Files that paint a raised surface in their OWN markup.
 *
 * Known limit: a reusable leaf never spells `bg-popover` - its surface is
 * whatever its caller mounted it on - so this scan cannot see a collapse in
 * a composed child. Carrying the context one hop along the import graph was
 * measured against this tree and flags 23 further load-bearing fills, each
 * needing its own surface trace (many resolve to `bg-canvas` via a raised
 * parent that mounts the child somewhere else entirely). That is an audit,
 * not a lint tightening, so it is deliberately not bundled here - see the
 * muted-on-popover audit artifact. The four composed-child collapses found
 * while measuring it ARE fixed in this changeset.
 */
function raisedSurfaceFiles(files: readonly string[]): ReadonlySet<string> {
  return new Set(
    files.filter((file) =>
      RAISED_SURFACE.test(withoutComments(readFileSync(file, "utf8"))),
    ),
  );
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
