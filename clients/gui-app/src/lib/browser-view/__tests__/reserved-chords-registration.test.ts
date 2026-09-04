import { describe, expect, it } from "vitest";
import {
  browserScopedChordLabel,
  reservedBrowserChordsFor,
} from "@/lib/browser-view/reserved-chords-registration";
import { getDefaultBindings, type ActionId } from "@/lib/keybindings/actions";
import type { ChordString } from "@/lib/keybindings/chord";
import { findConflict } from "@/lib/keybindings/conflicts";

type Bindings = Readonly<Record<ActionId, ChordString | null>>;

function bindingsWith(
  overrides: Partial<Record<ActionId, ChordString | null>>,
): Bindings {
  return { ...getDefaultBindings(), ...overrides };
}

function commandFor(
  bindings: Bindings,
  token: string,
): string | null | undefined {
  return reservedBrowserChordsFor(bindings).find((row) => row.token === token)
    ?.command;
}

function defaultCommandFor(token: string): string | null | undefined {
  return commandFor(getDefaultBindings(), token);
}

/**
 * The guest-focused input policy is ONE table. These pin what each disposition
 * means and that `conflicts.ts` derives from the same rows, so deleting a row
 * cannot quietly change behaviour on one side only.
 */
describe("reserved browser chords", () => {
  it("scopes the browser's own chords to the focused tile", () => {
    expect(defaultCommandFor("mod+w")).toBe("closeTab");
    expect(defaultCommandFor("mod+t")).toBe("newTab");
    expect(defaultCommandFor("mod+l")).toBe("focusAddressBar");
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
      expect(defaultCommandFor(token)).toBeNull();
    }
  });

  // The Start Page panel's own chords, from inside one of its browser tabs.
  // `terminalPolicy: "app"` does not cover this: it is about an xterm eating a
  // chord, and a native guest is not an xterm - the renderer's registry is not
  // in the delivery chain at all. Read against the action table so a default
  // rebind moves both sides together.
  it("forwards the panel's own new-tab and toggle chords", () => {
    const bindings = getDefaultBindings();
    expect(bindings["app.browser.new"]).toBe("mod+shift+b");
    expect(bindings["app.terminal.new"]).toBe("mod+shift+j");
    expect(bindings["app.terminal.toggle"]).toBe("mod+j");
    for (const token of ["mod+shift+b", "mod+shift+j", "mod+j"]) {
      expect(defaultCommandFor(token)).toBeNull();
    }
  });

  it("leaves everything else to the page", () => {
    // `epic.new` (mod+n) and the close-others family stay menu-/page-owned.
    expect(defaultCommandFor("mod+n")).toBeUndefined();
    expect(defaultCommandFor("mod+alt+w")).toBeUndefined();
  });

  /**
   * The forwarded rows follow the reader's LIVE binding, and the OLD default
   * has to stop being reserved in the same move.
   *
   * Reserving both would be worse than reserving neither: the stale chord stays
   * claimed for an action it no longer runs, so the page never sees it either.
   */
  it("follows a rebound action to its new chord and releases the old one", () => {
    const rebound = bindingsWith({ "epic.close": "mod+shift+e" });
    expect(commandFor(rebound, "mod+shift+e")).toBeNull();
    expect(commandFor(rebound, "mod+shift+w")).toBeUndefined();
  });

  /**
   * An UNBOUND action reserves nothing. There is no chord to claim, and holding
   * its old default would take a key away from the page for an action that can
   * no longer fire from any chord.
   */
  it("reserves nothing for an action the reader has unbound", () => {
    const unbound = bindingsWith({ "app.terminal.toggle": null });
    expect(commandFor(unbound, "mod+j")).toBeUndefined();
    // The rest of the policy is untouched - this is one row leaving, not the
    // derivation collapsing.
    expect(commandFor(unbound, "mod+shift+j")).toBeNull();
    expect(commandFor(unbound, "mod+w")).toBe("closeTab");
  });

  /**
   * A forwarded action rebound ONTO a browser-scoped chord does not get a
   * second row. Two rows for one token would leave main's last-write-wins table
   * deciding whether Cmd+W closes the browser tab or is replayed to the app,
   * which is precisely the ambiguity the rebinding UI already warns about.
   */
  it("does not duplicate a token the browser already scopes", () => {
    const collided = bindingsWith({ "epic.close": "mod+w" });
    const rows = reservedBrowserChordsFor(collided).filter(
      (row) => row.token === "mod+w",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.command).toBe("closeTab");
  });

  /**
   * Two forwarded actions on the SAME chord yield one row, not two.
   *
   * The rebinding UI warns about a duplicate but does not make one
   * unrepresentable - `mergePersistedKeybindings` can also carry a custom
   * binding forward onto a chord that has since become another action's
   * default. Main's table is keyed by token, so a second row for a token it
   * already holds is a silent last-write-wins.
   */
  it("emits one row when two forwarded actions share a chord", () => {
    const collided = bindingsWith({ "epic.next": "mod+k" });
    const rows = reservedBrowserChordsFor(collided).filter(
      (row) => row.token === "mod+k",
    );
    expect(rows).toHaveLength(1);
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
