/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  browserScopedChordLabel,
  reservedBrowserChordsFor,
} from "@/lib/browser-view/reserved-chords-registration";
import {
  ACTION_IDS,
  ACTION_META,
  getDefaultBindings,
  type ActionId,
} from "@/lib/keybindings/actions";
import type { ChordString } from "@/lib/keybindings/chord";
import { findConflict } from "@/lib/keybindings/conflicts";

type Bindings = Readonly<Record<ActionId, ChordString | null>>;

function isActionId(value: string): value is ActionId {
  return (ACTION_IDS as ReadonlyArray<string>).includes(value);
}

function bindingsWith(
  overrides: Partial<Record<ActionId, ChordString | null>>,
): Bindings {
  return { ...getDefaultBindings(), ...overrides };
}

/** The Start Page on screen, which is where every case below stands unless it says otherwise. */
const ON_LANDING = { landingSurfaceActive: true } as const;
const ON_EPIC = { landingSurfaceActive: false } as const;

function commandFor(
  bindings: Bindings,
  token: string,
): string | null | undefined {
  return reservedBrowserChordsFor(bindings, ON_LANDING).find(
    (row) => row.token === token,
  )?.command;
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
    expect(bindings["app.browser.new"]).toBe("mod+alt+b");
    expect(bindings["app.terminal.new"]).toBe("mod+shift+j");
    expect(bindings["app.terminal.toggle"]).toBe("mod+j");
    for (const token of ["mod+alt+b", "mod+shift+j", "mod+j"]) {
      expect(defaultCommandFor(token)).toBeNull();
    }
  });

  // Main's table is per WINDOW. With an epic canvas on screen the panel has no
  // handler registered for these (it gates on the same surface signal), so a
  // replayed key would go nowhere - and the canvas guest's page would have
  // lost it for nothing.
  it("leaves the panel's chords to the page while the Start Page is not on screen", () => {
    const rows = reservedBrowserChordsFor(getDefaultBindings(), ON_EPIC);
    const tokens = rows.map((row) => row.token);
    for (const token of ["mod+alt+b", "mod+shift+j", "mod+j"]) {
      expect(tokens).not.toContain(token);
    }
    // The app-level rows and the browser's own do not depend on the surface.
    expect(tokens).toContain("mod+shift+w");
    expect(tokens).toContain("mod+w");
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
    const rows = reservedBrowserChordsFor(collided, ON_LANDING).filter(
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
    const collided = bindingsWith({
      "epic.next": "mod+k",
      "epic.prev": "mod+k",
    });
    const rows = reservedBrowserChordsFor(collided, ON_LANDING).filter(
      (row) => row.token === "mod+k",
    );
    expect(rows).toHaveLength(1);
  });

  /**
   * The COMPLETENESS check, and the one that would have caught round 13's
   * omission: read against the panel's ACTUAL registrations rather than
   * against a remembered list.
   *
   * The panel's action ids are scanned out of its source because a list
   * restated here is the same defect one level up - it would have been written
   * with the same three names and agreed with the table forever. Every action
   * it registers under `useLandingTerminalSurfaceActive` must be forwarded, or
   * be claimed by a browser-scoped row (⌘T / ⌘W, which belong to the tile).
   *
   * What the scan can decide: which action ids that file names. It cannot
   * decide that they are all under the surface gate - today every
   * `registerDynamicActionHandler` in it sits inside an
   * `if (!surfaceActive) return;` effect, and a future one that does not would
   * be over-reserved here rather than under-reserved, which is the safe
   * direction.
   */
  it("forwards every chord the panel registers under the same surface gate", () => {
    // `fileURLToPath(import.meta.url)` and then `path`, not `new URL(rel,
    // base)`: jsdom installs its own `URL`, and Node rejects one of those with
    // "The URL must be of scheme file" whatever its href says.
    const panelSource = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../components/home/terminal-panel/landing-terminal-panel.tsx",
      ),
      "utf8",
    );
    const registered = new Set<ActionId>();
    for (const match of panelSource.matchAll(
      /(?:registerDynamicActionHandler\(\s*|actionId:\s*)"([A-Za-z0-9.-]+)"/g,
    )) {
      const id = match[1];
      if (isActionId(id)) registered.add(id);
    }
    // A scan that matched nothing - or that quietly matched FEWER than the
    // panel registers - would pass every assertion below, so the count is
    // asserted before they run. It caught its own first draft: a `[a-z0-9.-]`
    // id class skipped `tab.switch.byDigit` for its capital D, and without
    // this line the loop would have "verified" nine of ten registrations. A
    // tripwire, not a spec: raise it when the panel gains a registration.
    expect(registered.size).toBeGreaterThanOrEqual(10);

    const bindings = getDefaultBindings();
    const rows = reservedBrowserChordsFor(bindings, ON_LANDING);
    const reserved = new Set(rows.map((row) => row.token));

    for (const action of registered) {
      const chord = bindings[action];
      expect(chord, `${action} is unbound by default`).not.toBeNull();
      if (chord === null) continue;
      // A leader binds a MASK; the tokens it reserves are that mask over the
      // nine digits it dispatches.
      const tokens =
        ACTION_META[action].kind === "digit"
          ? [1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => `${chord}+${digit}`)
          : [chord];
      for (const token of tokens) {
        expect(
          reserved.has(token),
          `${action} (${token}) reaches the page from a focused panel browser`,
        ).toBe(true);
      }
    }
  });

  // The three round 13 left out, named so a deletion from the list above reads
  // as a deliberate change rather than as a silently shorter loop.
  it("forwards maximize, close-all and the tab-number leader", () => {
    const bindings = getDefaultBindings();
    expect(bindings["app.terminal.maximize"]).toBe("mod+alt+j");
    expect(bindings["tab.close-all"]).toBe("mod+shift+alt+w");
    expect(bindings["tab.switch.byDigit"]).toBe("mod");
    for (const token of ["mod+alt+j", "mod+shift+alt+w", "mod+1", "mod+9"]) {
      expect(defaultCommandFor(token)).toBeNull();
    }
  });

  /**
   * A leader reserves NINE tokens, and `0` is not one of them.
   *
   * `tab.switch.byDigit` maps `0` to index -1 and falls through, so reserving
   * ⌘0 would take the page's zoom-reset for an action that does nothing - and
   * the zoom chords are the one family this table deliberately leaves to the
   * guest handler.
   */
  it("expands the tab-number leader to 1-9 and stops there", () => {
    const tokens = reservedBrowserChordsFor(
      getDefaultBindings(),
      ON_LANDING,
    ).map((row) => row.token);
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(tokens).toContain(`mod+${digit}`);
    }
    expect(tokens).not.toContain("mod+0");
  });

  it("follows the leader to a rebound modifier, releasing the old digits", () => {
    const rebound = bindingsWith({ "tab.switch.byDigit": "mod+shift" });
    const tokens = reservedBrowserChordsFor(rebound, ON_LANDING).map(
      (row) => row.token,
    );
    expect(tokens).toContain("mod+shift+1");
    expect(tokens).not.toContain("mod+1");
  });

  it("leaves the leader's digits to the page while the Start Page is not on screen", () => {
    const tokens = reservedBrowserChordsFor(getDefaultBindings(), ON_EPIC).map(
      (row) => row.token,
    );
    expect(tokens).not.toContain("mod+1");
  });

  it("reserves no digits for an unbound leader", () => {
    const unbound = bindingsWith({ "tab.switch.byDigit": null });
    const tokens = reservedBrowserChordsFor(unbound, ON_LANDING).map(
      (row) => row.token,
    );
    expect(tokens).not.toContain("mod+1");
  });

  /**
   * One colliding digit costs that digit, not the leader.
   *
   * Per-action filtering would drop all nine because one of them met a
   * browser-scoped row, which is a much bigger loss than the collision.
   */
  it("drops only the colliding digit when one meets a browser-scoped row", () => {
    // `mod+l` is the address bar; a leader on plain `mod` cannot reach it, so
    // the collision is staged from the other side - a browser row's token
    // spelled as a digit is not possible, so rebind the leader to `alt` and
    // collide `alt+3` through a forwarded action instead.
    const collided = bindingsWith({
      "tab.switch.byDigit": "alt",
      "epic.close": "alt+3",
    });
    const tokens = reservedBrowserChordsFor(collided, ON_LANDING).map(
      (row) => row.token,
    );
    // `epic.close` is listed first, so it takes `alt+3`; the leader keeps the
    // other eight rather than losing the whole expansion to one `seen` hit.
    expect(tokens.filter((token) => token === "alt+3")).toHaveLength(1);
    for (const digit of [1, 2, 4, 5, 6, 7, 8, 9]) {
      expect(tokens).toContain(`alt+${digit}`);
    }
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
