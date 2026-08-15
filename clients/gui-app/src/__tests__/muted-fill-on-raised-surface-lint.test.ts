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

/** `bg-muted-foreground` is a TEXT color and is unaffected by the collapse. */
const MUTED_FILL = /bg-muted(?!-foreground)/;

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
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

type Offence = { readonly location: string; readonly line: string };

function findUnannotatedFills(file: string): readonly Offence[] {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  if (!RAISED_SURFACE.test(source)) return [];

  const offences: Offence[] = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (!MUTED_FILL.test(line)) return;
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
    const offences = collectTsxFiles(SRC_DIR).flatMap(findUnannotatedFills);

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
