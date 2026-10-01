/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The sheet-shell surface frames (ticket 02), asserted on the stylesheet's
 * text: jsdom applies no Tailwind utilities, so the margin/border/radius a
 * sheet owes cannot be read back from computed style.
 */

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of `@utility <name> { ... }`, braces matched. */
function utilityBody(name: string): string {
  const head = `@utility ${name} {`;
  const start = css.indexOf(head);
  if (start === -1) throw new Error(`no @utility ${name}`);
  return bracedBody(start + head.length);
}

/** The `{ ... }` body starting right after an already-consumed opening brace. */
function bracedBody(afterOpenBrace: number): string {
  let depth = 1;
  let index = afterOpenBrace;
  while (depth > 0 && index < css.length) {
    const char = css[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    index += 1;
  }
  return css.slice(afterOpenBrace, index - 1);
}

/** Each nested rule in a utility body: selector to declarations, whitespace collapsed. */
function nestedRules(body: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const flat = body
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
  for (const match of flat.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    map.set(match[1].trim(), match[2].trim());
  }
  return map;
}

/**
 * The declarations before any nested rule opens, whitespace collapsed.
 * Stops at the last `;` before the first `{` - the text between that `;` and
 * the `{` is the nested rule's own selector, not a top-level declaration.
 */
function topLevelDeclarations(body: string): string {
  const firstBrace = body.indexOf("{");
  const head = firstBrace === -1 ? body : body.slice(0, firstBrace);
  const lastSemicolon = head.lastIndexOf(";");
  return (lastSemicolon === -1 ? head : head.slice(0, lastSemicolon + 1))
    .replace(/\s+/g, " ")
    .trim();
}

describe.each([
  "task-surface-frame-beside-left",
  "task-surface-frame-beside-right",
])("%s", (name) => {
  it("no longer exists: every placement composes the same plain task-surface-frame", () => {
    // The beside utilities carried no geometry of their own (they just
    // `@apply task-surface-frame`), so the placement-specific wrapper was
    // pure duplication; callers now put `task-surface-frame` on the surface
    // frame directly for every placement.
    expect(css.includes(`@utility ${name} {`)).toBe(false);
  });
});

describe("task-surface-frame", () => {
  const body = utilityBody("task-surface-frame");
  const rules = nestedRules(body);

  it("flush surface: draws no margin or padding of its own, and still anchors the frame", () => {
    // Flush surface: the frame fills the space beside the strip and under
    // the header edge to edge - no ground inset any more, and no separate
    // tray plate around it either. It only anchors itself, for the sheet
    // join bridge to find.
    const declarations = topLevelDeclarations(body);
    expect(declarations).not.toContain("margin:");
    expect(declarations).not.toContain("padding:");
    expect(declarations).toContain("anchor-name: --task-frame;");
  });

  it("has no task-tray utility left in the stylesheet", () => {
    expect(css.includes("@utility task-tray {")).toBe(false);
  });

  it("has no leftover task-tray color tokens", () => {
    expect(css).not.toContain("--task-tray");
    expect(css).not.toContain("--task-tray-border");
  });

  it("draws one seam line, a 1px canvas border, on the edge facing the tabs - keyed by data-tab-edge", () => {
    expect(rules.get('&[data-tab-edge="top"]')).toBe(
      "border-top: 1px solid var(--canvas-border);",
    );
    expect(rules.get('&[data-tab-edge="left"]')).toBe(
      "border-left: 1px solid var(--canvas-border);",
    );
    expect(rules.get('&[data-tab-edge="right"]')).toBe(
      "border-right: 1px solid var(--canvas-border);",
    );
  });

  it("draws no border on any edge other than the one its own data-tab-edge names", () => {
    // Each rule owns exactly one border-* declaration - the one for its own
    // edge - so a top frame never also grows a left/right seam and vice
    // versa.
    for (const edge of ["top", "left", "right"] as const) {
      const declarations = rules.get(`&[data-tab-edge="${edge}"]`);
      if (declarations === undefined) {
        throw new Error(`no rule for data-tab-edge="${edge}"`);
      }
      const borderDeclarationCount = declarations
        .split(";")
        .filter((declaration) =>
          declaration.trim().startsWith("border"),
        ).length;
      expect(borderDeclarationCount).toBe(1);
    }
  });

  it("no longer gives every [data-shell-sheet] descendant its own border and radius: the epic canvas draws its own border now", () => {
    expect(rules.get("& [data-shell-sheet]")).toBeUndefined();
  });

  it("paints a single-sheet (non-epic) route in --canvas", () => {
    // Home/History/Settings mount `data-shell-sheet="route"` on their own
    // wrapper (`TopLevelSurfaceMount`); the epic surface paints its own two
    // panes itself and does not rely on this fill.
    expect(rules.get('& [data-shell-sheet="route"]')).toBe(
      "background-color: var(--canvas);",
    );
  });

  it("carries no leftover top-only concave-corner tricks", () => {
    // The old contract clipped a rounded top corner OUT of the frame with
    // `::before`/`::after` pseudo-elements; there is no radius left to clip
    // out any more.
    expect(body).not.toContain("::before");
    expect(body).not.toContain("::after");
    expect(body).not.toContain("content:");
    expect(body).not.toContain("margin-top: -1px");
  });
});

describe("[data-browser-guest-sheet]", () => {
  it("the clip-path rule is gone: flush surface leaves no sheet radius left to clip a guest to", () => {
    expect(css.includes("[data-browser-guest-sheet]")).toBe(false);
  });
});
