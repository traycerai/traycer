/**
 * The write predicate's truth table, pinned over the WHOLE granted enum, and
 * the decode that stands in front of it.
 *
 * The value of the table is the type annotation on {@link WRITABLE_BY_ROLE},
 * not the assertions under it: `Record<PermissionRole, boolean>` is a
 * compile-time exhaustiveness check, so a third granted role added to the enum
 * breaks this file rather than silently acquiring whatever the predicate's
 * shape happens to give it. A runtime loop over hardcoded strings would pass
 * unchanged that day, which is the failure mode worth spending a test on.
 *
 * The direction of failure is what makes it worth guarding at all: a predicate
 * that drifts OPEN queues writes against an epic the user has lost access to,
 * and nothing notices until the host refuses them.
 *
 * Every role a person can hold now writes, so the predicate's own answer is
 * only interesting for the inputs that are NOT a held role: `null`, and the
 * values that reach a client on the wire and resolve to none. Those arrive
 * through `grantedRole`, so the composition is what the cases below exercise -
 * calling the predicate on a wire string directly is a type error, which is
 * the point.
 */
import { describe, expect, it } from "vitest";
import { grantedRole } from "@traycer/protocol/common/permission-role";
import { LatestPermissionRoleSchema } from "@traycer/protocol/host/epic/unary-schemas";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import { isWritablePermissionRole } from "../permission-role";

const WRITABLE_BY_ROLE: Record<PermissionRole, boolean> = {
  owner: true,
  editor: true,
};

/** The retired view-only role, as a released peer still spells it. */
const RETIRED_WIRE_ROLE = "viewer";

describe("isWritablePermissionRole", () => {
  it("answers true for every role a grant may hold", () => {
    expect(isWritablePermissionRole("owner")).toBe(WRITABLE_BY_ROLE.owner);
    expect(isWritablePermissionRole("editor")).toBe(WRITABLE_BY_ROLE.editor);
  });

  it("fails closed on null", () => {
    // `null` on the wire is "the host cannot currently attribute a role", NOT
    // "no access" - but both readings are unwritable, and the consequence of a
    // wrong `true` is a mutation queued against an epic the caller may have
    // lost.
    expect(isWritablePermissionRole(null)).toBe(false);
  });

  it("fails closed on a wire role that grants nothing", () => {
    // The retired view-only role still crosses the wire - a released host
    // sends it, and refusing to decode it would take the frame down - so the
    // guarantee is about the COMPOSITION a client actually runs: decode, then
    // ask. An unknown value from a newer writer takes the same path, because a
    // role nobody granted write access to must not acquire it by arriving late.
    expect(isWritablePermissionRole(grantedRole(RETIRED_WIRE_ROLE))).toBe(
      false,
    );
    expect(isWritablePermissionRole(grantedRole("auditor"))).toBe(false);
  });

  it("covers every role the released enum actually carries", () => {
    // The other half of the exhaustiveness guard. The `Record` type above
    // catches a granted role added to the enum and missing here; this catches a
    // key here that the released wire does not have - a rename that left a
    // stale entry behind, which would otherwise read as coverage. The retired
    // role is checked alongside them because the wire still has to parse it.
    for (const role of [...Object.keys(WRITABLE_BY_ROLE), RETIRED_WIRE_ROLE]) {
      expect(() => LatestPermissionRoleSchema.parse(role)).not.toThrow();
    }
  });
});
