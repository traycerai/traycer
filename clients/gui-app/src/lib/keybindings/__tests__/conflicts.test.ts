import { describe, expect, it } from "vitest";
import { findConflict } from "@/lib/keybindings/conflicts";
import { getDefaultBindings } from "@/lib/keybindings/actions";

describe("findConflict", () => {
  it("flags a duplicate against another action", () => {
    const bindings = getDefaultBindings();
    // `group.split.vertical` ships as `mod+shift+d`; binding another action to
    // the same chord must report a duplicate.
    const result = findConflict(bindings, "epic.new", "mod+shift+d", []);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("duplicate");
    expect(result?.conflictingActionId).toBe("group.split.vertical");
  });

  it("returns null when the candidate is free", () => {
    const bindings = getDefaultBindings();
    const result = findConflict(bindings, "epic.new", "mod+shift+o", []);
    expect(result).toBeNull();
  });

  it("skips the action itself (re-saving its own chord is fine)", () => {
    const bindings = getDefaultBindings();
    const result = findConflict(
      bindings,
      "group.split.vertical",
      "mod+shift+d",
      [],
    );
    expect(result).toBeNull();
  });

  it("warns on an OS-clash chord not otherwise bound", () => {
    const bindings = { ...getDefaultBindings(), "epic.new": null };
    const result = findConflict(bindings, "epic.new", "mod+q", []);
    expect(result?.severity).toBe("os-clash");
  });

  describe("bidirectional external-reserved conflicts (the desktop global summon shortcut)", () => {
    it("flags a duplicate when capturing a global chord that a renderer action already owns", () => {
      // Capturing a candidate chord for a global shortcut isn't itself a
      // renderer action, so there is no id to exclude from the scan.
      const bindings = getDefaultBindings();
      const result = findConflict(bindings, null, "mod+shift+d", []);
      expect(result?.severity).toBe("duplicate");
      expect(result?.conflictingActionId).toBe("group.split.vertical");
    });

    it("flags a duplicate when a renderer capture collides with the live global chord", () => {
      const bindings = { ...getDefaultBindings(), "epic.new": null };
      const result = findConflict(bindings, "epic.new", "mod+shift+space", [
        {
          id: "global.summon",
          label: "Summon Traycer (global shortcut)",
          chord: "mod+shift+space",
        },
      ]);
      expect(result?.severity).toBe("duplicate");
      expect(result?.conflictingActionId).toBeNull();
      expect(result?.message).toContain("Summon Traycer (global shortcut)");
    });

    it("ignores an externally reserved chord that doesn't match the candidate", () => {
      const bindings = { ...getDefaultBindings(), "epic.new": null };
      const result = findConflict(bindings, "epic.new", "mod+shift+o", [
        {
          id: "global.summon",
          label: "Summon Traycer (global shortcut)",
          chord: "mod+shift+space",
        },
      ]);
      expect(result).toBeNull();
    });
  });
});
