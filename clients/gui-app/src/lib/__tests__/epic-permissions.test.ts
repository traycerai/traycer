import { describe, expect, it } from "vitest";
import { isEditableRole, mutationDisabledHint } from "@/lib/epic-permissions";

describe("isEditableRole", () => {
  it("treats owner and editor as editable", () => {
    expect(isEditableRole("owner")).toBe(true);
    expect(isEditableRole("editor")).toBe(true);
  });

  it("treats viewer and null as not editable", () => {
    expect(isEditableRole("viewer")).toBe(false);
    expect(isEditableRole(null)).toBe(false);
  });
});

describe("mutationDisabledHint", () => {
  it("returns null for an editable, connected role", () => {
    expect(mutationDisabledHint("editor", false, "create chats")).toBeNull();
    expect(mutationDisabledHint("owner", false, "create chats")).toBeNull();
  });

  it("explains a viewer's restriction with the given action", () => {
    expect(mutationDisabledHint("viewer", false, "create chats")).toBe(
      "Viewers cannot create chats.",
    );
    expect(mutationDisabledHint("viewer", false, "create artifacts")).toBe(
      "Viewers cannot create artifacts.",
    );
  });

  it("prefers the reconnect hint over the role hint when both apply", () => {
    expect(mutationDisabledHint("viewer", true, "create chats")).toBe(
      "Reconnect to make changes.",
    );
  });

  it("surfaces the reconnect hint for an editable role while disconnected", () => {
    expect(mutationDisabledHint("editor", true, "create chats")).toBe(
      "Reconnect to make changes.",
    );
  });

  it("distinguishes a role that is not yet known (null) from a real viewer", () => {
    // `null` means "not known here" (see `epicStatusSubscribeSnapshotFrameSchemaV10`'s
    // `permissionRole` doc comment), not "confirmed viewer" - a control that reads
    // "Viewers cannot ..." for a role the host simply hasn't resolved yet is a
    // false, specific claim about the caller's access.
    expect(mutationDisabledHint(null, false, "create chats")).toBe(
      "Task permissions are not available yet.",
    );
    // Still gated exactly like a viewer - not editable, regardless of copy.
    expect(isEditableRole(null)).toBe(false);
  });
});
