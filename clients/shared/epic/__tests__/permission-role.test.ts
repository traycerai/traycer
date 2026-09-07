/** The write predicate's truth table, pinned over the whole role enum. */
import { describe, expect, it } from "vitest";
import { LatestPermissionRoleSchema } from "@traycer/protocol/host/epic/unary-schemas";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import { isWritablePermissionRole } from "../permission-role";

const WRITABLE_BY_ROLE: Record<PermissionRole, boolean> = {
  owner: true,
  editor: true,
  viewer: false,
};

describe("isWritablePermissionRole", () => {
  it("answers true for owner and editor, false for viewer", () => {
    expect(isWritablePermissionRole("owner")).toBe(WRITABLE_BY_ROLE.owner);
    expect(isWritablePermissionRole("editor")).toBe(WRITABLE_BY_ROLE.editor);
    expect(isWritablePermissionRole("viewer")).toBe(WRITABLE_BY_ROLE.viewer);
  });

  it("fails closed on null", () => {
    // `null` on the wire is "the host cannot currently attribute a role", not "no access" - but both readings are unwritable, and the consequence of a wrong `true` is a mutation queued against an epic the caller may have lost.
    expect(isWritablePermissionRole(null)).toBe(false);
  });

  it("covers every role the released enum actually carries", () => {
    // The other half of the exhaustiveness guard.
    for (const role of Object.keys(WRITABLE_BY_ROLE)) {
      expect(() => LatestPermissionRoleSchema.parse(role)).not.toThrow();
    }
  });
});
