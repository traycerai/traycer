/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `handle.store(selector)` - a zustand bound-store hook reached through a
 * property name - is not recognizable as a hook to the React Compiler
 * (`vitest.react-compiler.config.ts`, `@rolldown/plugin-babel` +
 * `reactCompilerPreset()` in the desktop renderer's real build). The
 * compiler memoizes the call on the receiver and, on a later render with the
 * same receiver, skips it entirely instead of re-invoking the real hook -
 * silently going stale, or shifting the hook order. `use-epic-node-mutations.ts`
 * reintroduced this after it had already been fixed and documented twice
 * (`use-terminal-crash-notification.ts`, `chat-progress-icon.tsx`). The fix
 * is always `useStore(handle.store, selector)` from `zustand` - a plain
 * identifier call the compiler DOES recognize as a hook.
 *
 * Scope: every production file under `src/`, not just `.tsx` - the defect
 * lived entirely in a `.ts` hooks file with no JSX in it.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A member call on a `store`/`Store`-suffixed property, given a selector
 * argument (an inline arrow, or a `use...` reference passed through).
 */
const PROPERTY_INVOKED_HOOK = /\.\w*[sS]tore\(\s*(\(|use[A-Z])/;

/** Per-line waiver, same line as the offending call. */
const ALLOW_MARKER = /property-hook-ok:\s*(?!\*\/)\S/;

/** A comment line is prose, not markup. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*");
}

function collectProductionFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...collectProductionFiles(full));
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(?:ts|tsx)$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

type Offence = { readonly location: string; readonly line: string };

function findUnwaivedPropertyInvokedHooks(file: string): readonly Offence[] {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const offences: Offence[] = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) return;
    if (!PROPERTY_INVOKED_HOOK.test(line)) return;
    if (ALLOW_MARKER.test(line)) return;
    const relative = path.relative(SRC_DIR, file).split(path.sep).join("/");
    offences.push({
      location: `${relative}:${String(index + 1)}`,
      line: line.trim(),
    });
  });
  return offences;
}

describe("property-invoked store hooks", () => {
  it("every store call reached through a property is either useStore(api, selector) or waived", () => {
    const files = collectProductionFiles(SRC_DIR);
    const offences = files.flatMap((file) =>
      findUnwaivedPropertyInvokedHooks(file),
    );

    expect(offences.map((offence) => offence.location)).toEqual([]);
  });

  it("the detector pattern itself matches the documented trap shape", () => {
    expect(PROPERTY_INVOKED_HOOK.test("handle.store((state) => state.x)")).toBe(
      true,
    );
    expect(
      PROPERTY_INVOKED_HOOK.test("props.handle.store((state) => state.x)"),
    ).toBe(true);
    expect(PROPERTY_INVOKED_HOOK.test("handle.someStore(useSelector)")).toBe(
      true,
    );
    expect(
      PROPERTY_INVOKED_HOOK.test("useStore(handle.store, (state) => state.x)"),
    ).toBe(false);
    expect(PROPERTY_INVOKED_HOOK.test("handle.store.getState()")).toBe(false);
  });

  it("a waiver with no reason excuses nothing", () => {
    expect(ALLOW_MARKER.test("// property-hook-ok:")).toBe(false);
    expect(ALLOW_MARKER.test("/* property-hook-ok: */")).toBe(false);
    expect(
      ALLOW_MARKER.test("// property-hook-ok: not a hook, plain getter"),
    ).toBe(true);
  });
});
