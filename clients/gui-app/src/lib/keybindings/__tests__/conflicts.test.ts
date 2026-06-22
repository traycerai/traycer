import { describe, expect, it } from "vitest";
import { findConflict } from "@/lib/keybindings/conflicts";
import { getDefaultBindings } from "@/lib/keybindings/actions";

describe("findConflict", () => {
  it("flags a duplicate against another action", () => {
    const bindings = getDefaultBindings();
    // `group.split.vertical` ships as `mod+shift+d`; binding another action to
    // the same chord must report a duplicate.
    const result = findConflict(bindings, "epic.new", "mod+shift+d");
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("duplicate");
    expect(result?.conflictingActionId).toBe("group.split.vertical");
  });

  it("returns null when the candidate is free", () => {
    const bindings = getDefaultBindings();
    const result = findConflict(bindings, "epic.new", "mod+shift+o");
    expect(result).toBeNull();
  });

  it("skips the action itself (re-saving its own chord is fine)", () => {
    const bindings = getDefaultBindings();
    const result = findConflict(
      bindings,
      "group.split.vertical",
      "mod+shift+d",
    );
    expect(result).toBeNull();
  });

  it("warns on an OS-clash chord not otherwise bound", () => {
    const bindings = { ...getDefaultBindings(), "epic.new": null };
    const result = findConflict(bindings, "epic.new", "mod+q");
    expect(result?.severity).toBe("os-clash");
  });
});
