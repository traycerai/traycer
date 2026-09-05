import { describe, expect, it } from "vitest";
import {
  RESERVED_BROWSER_CHORDS,
  browserScopedChordLabel,
} from "@/lib/browser-view/reserved-chords-registration";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { findConflict } from "@/lib/keybindings/conflicts";

function commandFor(token: string): string | null | undefined {
  return RESERVED_BROWSER_CHORDS.find((row) => row.token === token)?.command;
}

/**
 * The guest-focused input policy is ONE table. These pin what each disposition
 * means and that `conflicts.ts` derives from the same rows, so deleting a row
 * cannot quietly change behaviour on one side only.
 */
describe("reserved browser chords", () => {
  it("scopes the browser's own chords to the focused tile", () => {
    expect(commandFor("mod+w")).toBe("closeTab");
    expect(commandFor("mod+t")).toBe("newTab");
    expect(commandFor("mod+l")).toBe("focusAddressBar");
  });

  it("forwards app-level navigation to the renderer instead", () => {
    for (const token of [
      "mod+k",
      "mod+shift+w",
      "mod+]",
      "mod+[",
      "mod+shift+]",
      "mod+shift+[",
    ]) {
      expect(commandFor(token)).toBeNull();
    }
  });

  it("leaves everything else to the page", () => {
    // `epic.new` (mod+n) and the close-others family stay menu-/page-owned.
    expect(commandFor("mod+n")).toBeUndefined();
    expect(commandFor("mod+alt+w")).toBeUndefined();
  });

  it("labels only the browser-scoped rows", () => {
    expect(browserScopedChordLabel("mod+w")).not.toBeNull();
    expect(browserScopedChordLabel("mod+shift+w")).toBeNull();
    expect(browserScopedChordLabel("mod+alt+w")).toBeNull();
  });

  it("matches CANONICAL tokens only", () => {
    // Documented assumption: a chord reaching this table has round-tripped
    // through `parseChordString`/`formatChord`, so `mod+w` is the only
    // spelling of Cmd+W. A raw `meta+w` is not canonical and gets no warning.
    // If a caller ever holds unnormalized input, normalize at that caller
    // rather than teaching this table more spellings.
    expect(browserScopedChordLabel("meta+w")).toBeNull();
    expect(browserScopedChordLabel("Mod+W")).toBeNull();
  });
});

describe("keybinding conflicts derive from the policy table", () => {
  it("warns that a browser-scoped chord will not reach the app", () => {
    // `tab.close` itself is excluded, so the duplicate scan cannot answer
    // first and the browser-tile warning is what remains.
    const result = findConflict(getDefaultBindings(), "tab.close", "mod+w", []);
    expect(result?.severity).toBe("os-clash");
    expect(result?.message).toContain("browser tile");
  });

  it("does not warn for an app-forwarded chord", () => {
    const forwarded = findConflict(
      getDefaultBindings(),
      "epic.close",
      "mod+shift+w",
      [],
    );
    // Still its own binding, so no duplicate either - the point is that being
    // reserved for forwarding is NOT a clash.
    expect(forwarded).toBeNull();
  });
});
