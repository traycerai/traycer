/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** `bg-muted` on a raised surface is invisible in most presets. Prefer a foreground alpha. Safe fills keep {@link ALLOW_MARKER} on the line they excuse. */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Raised-surface markers. Primitives (`<Card`) matter as much as `bg-card`; `SettingsPanelShell`/`SettingsGroup` paint `bg-card/40` themselves. */
const RAISED_SURFACE =
  /DialogContent|AlertDialogContent|PopoverContent|HoverCardContent|DropdownMenuContent|SheetContent|ContextMenuContent|SelectContent|SettingsPanelShell|SettingsGroup|<Card|bg-popover|bg-card/;

/** Muted fills, including `var(--muted)`. `bg-muted-foreground` is text and is excluded. */
const MUTED_FILL =
  /bg-muted(?!-foreground)|var\(--muted\)|var\(--color-muted\)/;

/** Opt-out for a fill a collapse cannot erase. Must be followed by a reason. Exclude the comment terminator (`*\/`) specifically, not "anything unlike a word". */
const ALLOW_MARKER = /muted-fill-ok:\s*(?!\*\/)\S/;

/** Lines above a fill an annotation may sit. Keep the marker last, adjacent to the class list it excuses. */
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

/** State-prefixed muted fill. A static border does not excuse it; only another state-prefixed channel does. */
const STATE_MUTED_FILL = /[a-z-]+(?:\[[^\]]*\])?:bg-muted/;
const STATE_OTHER_CHANNEL =
  /[a-z-]+(?:\[[^\]]*\])?:(?:text|border|ring|shadow|outline|opacity)-/;

/** A collapse erases a solid fill or one at >= /40. Below that, a border means the fill is not load-bearing. */
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

/** Local `.tsx` imports, so raised-surface context carries one hop into composed children. */
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
 * Raised-surface files plus one hop of imported children. Caller-composed bodies are out of scope.
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

  /** A malformed muted-fill-ok marker becomes JsxText and breaks asChild Slot. */
  it("a waiver with no reason excuses nothing", () => {
    // Bare muted-fill-ok must not count. Both forms `\S` accepted: JSX `*` closer
    // and a line comment with nothing after the colon.
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

    // Reason need not start with a letter; [A-Za-z] rejected real waivers.
    // Do not tighten to whatever shape current waivers happen to have.
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
