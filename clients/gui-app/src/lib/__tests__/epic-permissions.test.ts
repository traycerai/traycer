import { describe, expect, it } from "vitest";
import { isEditableRole, mutationDisabledHint } from "@/lib/epic-permissions";

describe("isEditableRole", () => {
  it("treats owner and editor as editable", () => {
    expect(isEditableRole("owner")).toBe(true);
    expect(isEditableRole("editor")).toBe(true);
  });

  it("treats an unresolved role as not editable", () => {
    expect(isEditableRole(null)).toBe(false);
  });
});

describe("mutationDisabledHint", () => {
  it("returns null for an editable, connected role", () => {
    expect(mutationDisabledHint("editor", false)).toBeNull();
    expect(mutationDisabledHint("owner", false)).toBeNull();
  });

  it("prefers the reconnect hint over the role hint when both apply", () => {
    expect(mutationDisabledHint(null, true)).toBe("Reconnect to make changes.");
  });

  it("surfaces the reconnect hint for an editable role while disconnected", () => {
    expect(mutationDisabledHint("editor", true)).toBe(
      "Reconnect to make changes.",
    );
  });

  it("says permissions are not available yet for a role that is not known", () => {
    // `null` means "not known here" (see `epicStatusSubscribeSnapshotFrameSchemaV10`'s
    // `permissionRole` doc comment), and is also what a role that grants
    // nothing decodes to: neither is a claim about the caller's access.
    expect(mutationDisabledHint(null, false)).toBe(
      "Task permissions are not available yet.",
    );
  });
});
