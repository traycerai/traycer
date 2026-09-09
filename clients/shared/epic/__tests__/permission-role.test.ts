/**
 * The write predicate's truth table, pinned over the WHOLE role enum.
 *
 * The value of this file is the type annotation on {@link WRITABLE_BY_ROLE},
 * not the assertions under it: `Record<PermissionRole, boolean>` is a
 * compile-time exhaustiveness check, so a fourth role added to the enum breaks
 * this file rather than silently acquiring whatever the predicate's shape
 * happens to give it. A runtime loop over three hardcoded strings would pass
 * unchanged that day, which is the failure mode worth spending a test on.
 *
 * The direction of failure is what makes it worth guarding at all: a predicate
 * that drifts OPEN queues writes against an epic the user has lost access to,
 * and nothing notices until the host refuses them.
 */
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
    // `null` on the wire is "the host cannot currently attribute a role", NOT
    // "no access" - but both readings are unwritable, and the consequence of a
    // wrong `true` is a mutation queued against an epic the caller may have
    // lost.
    expect(isWritablePermissionRole(null)).toBe(false);
  });

  it("covers every role the released enum actually carries", () => {
    // The other half of the exhaustiveness guard. The `Record` type above
    // catches a role added to the enum and missing here; this catches a key
    // here that the enum does not have - a rename that left a stale entry
    // behind, which would otherwise read as coverage.
    for (const role of Object.keys(WRITABLE_BY_ROLE)) {
      expect(() => LatestPermissionRoleSchema.parse(role)).not.toThrow();
    }
  });
});
