/**
 * The status lane's control events in the `@1` replica's vocabulary.
 *
 * Three arms are renames and are pinned once each. The two that are not - the
 * permission role and the aggregate dirty bit - are where a translation can be
 * wrong in a way nothing downstream would notice, and they get the detail.
 */
import { describe, expect, it } from "vitest";
import { isWritablePermissionRole } from "@traycer-clients/shared/epic/permission-role";
import type { ControlEvent } from "@traycer-clients/shared/replica-runtime";
import { legacyControlEventOf } from "../lane-control-translation";

function permissionChanged(role: string | null): ControlEvent {
  return {
    kind: "permission-changed",
    role,
    // What the ADAPTER computed, fail-closed, from the same value.
    canWrite: isWritablePermissionRole(
      role === "owner" || role === "editor" || role === "viewer" ? role : null,
    ),
    securityEpoch: 1,
  };
}

describe("permission role: the seam widened it, so the translation narrows it back", () => {
  it("passes the two writable roles through", () => {
    for (const role of ["owner", "editor"] as const) {
      expect(legacyControlEventOf(permissionChanged(role))).toEqual({
        kind: "permission-changed",
        role,
      });
    }
  });

  it("passes viewer through - unwritable is not the same as unattributable", () => {
    expect(legacyControlEventOf(permissionChanged("viewer"))).toEqual({
      kind: "permission-changed",
      role: "viewer",
    });
  });

  it("narrows an UNRECOGNISED role to null, and null is unwritable", () => {
    // The direction that matters. The `@1` replica recomputes writability from
    // the role, and `canWrite` is DROPPED by this translation - so if an
    // unrecognised role narrowed onto a writable one, the client would grant
    // write access the adapter had already refused fail-closed.
    const translated = legacyControlEventOf(
      permissionChanged("some-role-a-newer-host-invented"),
    );
    expect(translated).toEqual({ kind: "permission-changed", role: null });
    expect(isWritablePermissionRole(null)).toBe(false);
  });

  it("agrees with the adapter's fail-closed canWrite on every input", () => {
    // The invariant behind the drop: whatever the adapter decided about
    // writability, recomputing it from the narrowed role must land in the same
    // place. If these ever disagreed, one of two things would be true on the
    // wire and the client would believe the wrong one.
    for (const role of [
      "owner",
      "editor",
      "viewer",
      "some-role-a-newer-host-invented",
      null,
    ]) {
      const event = permissionChanged(role);
      const translated = legacyControlEventOf(event);
      if (translated.kind !== "permission-changed") {
        throw new Error("expected a permission-changed event");
      }
      expect(isWritablePermissionRole(translated.role)).toBe(event.canWrite);
    }
  });

  it("passes an explicit null through - the host cannot attribute a role", () => {
    expect(legacyControlEventOf(permissionChanged(null))).toEqual({
      kind: "permission-changed",
      role: null,
    });
  });
});

describe("aggregate dirty: ONE boolean, and it ESTABLISHES", () => {
  it("maps onto the ATOMIC snapshot arm, with an empty room list", () => {
    // Not the `root-dirty` delta arm. On `@1` only the atomic `dirtySnapshot`
    // may establish dirtiness for sync-pill purposes, because a delta cannot
    // prove the subscription has seen every room. The lane's boolean is the
    // authority's complete answer - root OR any room - so it establishes, and
    // its empty room list is a true statement about a wire that carries no
    // per-room detail rather than a stub.
    expect(
      legacyControlEventOf({ kind: "aggregate-dirty", dirty: true }),
    ).toEqual({ kind: "dirty-snapshot", rootDirty: true, rooms: [] });
    expect(
      legacyControlEventOf({ kind: "aggregate-dirty", dirty: false }),
    ).toEqual({ kind: "dirty-snapshot", rootDirty: false, rooms: [] });
  });
});

describe("cloud sync status", () => {
  it("passes the three known values through", () => {
    for (const status of ["connected", "reconnecting", "disconnected"]) {
      expect(
        legacyControlEventOf({
          kind: "cloud-sync-status",
          status,
          observedAtMs: 0,
        }),
      ).toEqual({ kind: "cloud-sync-status", status });
    }
  });

  it("falls back to disconnected on an unrecognised value, never connected", () => {
    // The status feeds a freshness claim, so a default that reads as connected
    // is the false-clean direction this plane exists to forbid.
    expect(
      legacyControlEventOf({
        kind: "cloud-sync-status",
        status: "a-status-a-newer-host-invented",
        observedAtMs: 0,
      }),
    ).toEqual({ kind: "cloud-sync-status", status: "disconnected" });
  });
});

describe("migration and deletion are renames, and the words differ on purpose", () => {
  it("maps the lifecycle onto the @1 phase vocabulary", () => {
    expect(
      legacyControlEventOf({
        kind: "migration",
        migration: { status: "started" },
      }),
    ).toEqual({ kind: "migration", migration: { phase: "started" } });

    // The seam calls the STAGE `stage` and the wire calls it `phase`; the seam
    // calls the LIFECYCLE `status` and the wire calls that `phase` too. This is
    // the boundary where that collision is resolved rather than allowed to give
    // one word two meanings.
    expect(
      legacyControlEventOf({
        kind: "migration",
        migration: {
          status: "progress",
          stage: "upload",
          chunksDone: 3,
          chunksTotal: 7,
        },
      }),
    ).toEqual({
      kind: "migration",
      migration: {
        phase: "progress",
        step: "upload",
        chunksDone: 3,
        chunksTotal: 7,
      },
    });

    expect(
      legacyControlEventOf({
        kind: "migration",
        migration: { status: "failed", reason: "upstream refused" },
      }),
    ).toEqual({
      kind: "migration",
      migration: { phase: "failed", reason: "upstream refused" },
    });

    expect(
      legacyControlEventOf({
        kind: "migration",
        migration: { status: "not-allowed" },
      }),
    ).toEqual({ kind: "migration", migration: { phase: "not-allowed" } });
  });

  it("carries deletion attribution, including when the authority has none", () => {
    // Carried rather than dropped: it is what the renderer says when it
    // force-closes the tab - "deleted by Alice" against "it vanished" - and
    // both fields are nullable because the authority may know the epic is gone
    // without knowing who removed it.
    expect(
      legacyControlEventOf({
        kind: "epic-deleted",
        deletedByDisplayName: "Alice",
        deletedByTraycerUserId: "u-1",
      }),
    ).toEqual({
      kind: "epic-deleted",
      attribution: {
        deletedByDisplayName: "Alice",
        deletedByTraycerUserId: "u-1",
      },
    });

    expect(
      legacyControlEventOf({
        kind: "epic-deleted",
        deletedByDisplayName: null,
        deletedByTraycerUserId: null,
      }),
    ).toEqual({
      kind: "epic-deleted",
      attribution: {
        deletedByDisplayName: null,
        deletedByTraycerUserId: null,
      },
    });
  });
});
