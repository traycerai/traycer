import { describe, expect, it } from "vitest";
import type { HostHealth } from "@/components/settings/host-scope/host-health";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  buildSweepHostPickerRows,
  groupSweepHostPickerRows,
  namesHostOutsideSurface,
  sweepNeedsHostPicker,
  unionHostIds,
} from "@/components/epics/sweep-host-model";
import { parseHostIdStamp, stampHostIds } from "@/lib/host/host-id-stamp";

const HEALTH: HostHealth = {
  state: "online",
  label: "Online",
  detail: null,
  tone: "live",
  live: true,
};

function hostOption(hostId: string): HostScopeOption {
  return {
    hostId,
    name: hostId,
    isLocalMachine: false,
    isActive: false,
    connectable: true,
    planRestricted: false,
    settingUp: false,
    registered: true,
    platform: null,
    version: null,
    health: HEALTH,
    updateState: null,
    entry: null,
    item: null,
  };
}

describe("sweepNeedsHostPicker", () => {
  it("asks nothing when there is one dialable host", () => {
    // The hard requirement: a single-host install must see byte-for-byte the
    // Sweep it had before multi-host Sweep existed.
    expect(sweepNeedsHostPicker(["host-a"])).toBe(false);
  });

  it("asks nothing when NO host is dialable", () => {
    // There is no question to put to a person here either - the dialog's own
    // empty/error state is the honest answer.
    expect(sweepNeedsHostPicker([])).toBe(false);
  });

  it("asks once a second host is dialable", () => {
    expect(sweepNeedsHostPicker(["host-a", "host-b"])).toBe(true);
  });
});

describe("namesHostOutsideSurface", () => {
  it("says yes when provenance reaches past the surface's host", () => {
    // The gate clause that keeps the picker reachable for a multi-host Task.
    expect(
      namesHostOutsideSurface({
        hostIds: ["host-a", "host-b"],
        surfaceHostId: "host-a",
      }),
    ).toBe(true);
  });

  it("says no when everything lives on the surface's own host", () => {
    expect(
      namesHostOutsideSurface({
        hostIds: ["host-a", "host-a"],
        surfaceHostId: "host-a",
      }),
    ).toBe(false);
  });

  it("reads silence as no evidence, never as evidence of elsewhere", () => {
    // `null` is a peer that predates the field, not a Task with hosts. The
    // surface's own worktree listing is still the other half of the gate.
    expect(
      namesHostOutsideSurface({ hostIds: null, surfaceHostId: "host-a" }),
    ).toBe(false);
    expect(
      namesHostOutsideSurface({ hostIds: [], surfaceHostId: "host-a" }),
    ).toBe(false);
  });

  it("says no when the surface has no host of its own", () => {
    // There is no client to sweep with, so there is nothing to compare
    // against - and enabling an affordance whose every route is null would
    // only lead to a dialog that cannot ask anything.
    expect(
      namesHostOutsideSurface({ hostIds: ["host-b"], surfaceHostId: null }),
    ).toBe(false);
  });
});

describe("unionHostIds", () => {
  it("folds several Tasks' provenance into one set", () => {
    expect(
      [
        ...unionHostIds([
          ["host-a", "host-b"],
          ["host-b", "host-c"],
        ]),
      ].sort(),
    ).toEqual(["host-a", "host-b", "host-c"]);
  });

  it("treats an unanswerable row as contributing nothing, not as a verdict", () => {
    // `null` (a peer that predates `chatHostIds`) and `[]` (this Task has no
    // chats anywhere) reach the same badge set. Only one of them is a fact,
    // and neither is allowed to REMOVE a host from the picker.
    expect([...unionHostIds([null, ["host-a"]])]).toEqual(["host-a"]);
    expect([...unionHostIds([null, null])]).toEqual([]);
  });
});

describe("buildSweepHostPickerRows", () => {
  it("keeps every host, marking occupancy and the surface's default", () => {
    const rows = buildSweepHostPickerRows({
      hosts: [hostOption("host-a"), hostOption("host-b"), hostOption("host-c")],
      occupiedHostIds: new Set(["host-b"]),
      defaultHostId: "host-a",
    });

    // Never filtered: a host with no record naming it can still hold the
    // Task's worktrees, because owner-binding cascades are best-effort.
    expect(rows.map((row) => row.host.hostId)).toEqual([
      "host-a",
      "host-b",
      "host-c",
    ]);
    expect(rows.map((row) => row.occupied)).toEqual([false, true, false]);
    expect(rows.map((row) => row.isDefault)).toEqual([true, false, false]);
  });

  it("marks no default when the surface has no host", () => {
    const rows = buildSweepHostPickerRows({
      hosts: [hostOption("host-a")],
      occupiedHostIds: new Set(),
      defaultHostId: null,
    });
    expect(rows[0].isDefault).toBe(false);
  });
});

describe("groupSweepHostPickerRows", () => {
  function rows(input: {
    readonly occupied: readonly string[];
    readonly defaultHostId: string | null;
  }) {
    return buildSweepHostPickerRows({
      hosts: [hostOption("host-a"), hostOption("host-b"), hostOption("host-c")],
      occupiedHostIds: new Set(input.occupied),
      defaultHostId: input.defaultHostId,
    });
  }

  function ids(
    group: readonly { readonly host: { readonly hostId: string } }[],
  ) {
    return group.map((row) => row.host.hostId);
  }

  it("lifts badged hosts to the top level, badged first", () => {
    const groups = groupSweepHostPickerRows(
      rows({ occupied: ["host-c"], defaultHostId: "host-a" }),
    );
    // Badged leads even though the shared picker's order puts host-a first:
    // that ordering is the claim the group is making.
    expect(ids(groups.primary)).toEqual(["host-c", "host-a"]);
    expect(ids(groups.other)).toEqual(["host-b"]);
  });

  it("never demotes the default host, even unbadged", () => {
    const groups = groupSweepHostPickerRows(
      rows({ occupied: ["host-b"], defaultHostId: "host-c" }),
    );
    expect(ids(groups.primary)).toEqual(["host-b", "host-c"]);
    // Hiding the PRE-SELECTED host behind a disclosure is the one thing the
    // grouping must never do.
    expect(ids(groups.other)).toEqual(["host-a"]);
  });

  it("counts a host that is both badged and default only once", () => {
    const groups = groupSweepHostPickerRows(
      rows({ occupied: ["host-a"], defaultHostId: "host-a" }),
    );
    expect(ids(groups.primary)).toEqual(["host-a"]);
    expect(ids(groups.other)).toEqual(["host-b", "host-c"]);
  });

  it("renders flat when nothing is badged and there is no default", () => {
    // Every row would otherwise land under the disclosure, and a wholly
    // collapsed list is strictly worse than the flat one it replaced.
    const groups = groupSweepHostPickerRows(
      rows({ occupied: [], defaultHostId: null }),
    );
    expect(ids(groups.primary)).toEqual(["host-a", "host-b", "host-c"]);
    expect(groups.other).toEqual([]);
  });

  it("grows no disclosure when every host is already top-level", () => {
    const groups = groupSweepHostPickerRows(
      rows({ occupied: ["host-a", "host-b", "host-c"], defaultHostId: null }),
    );
    expect(ids(groups.primary)).toEqual(["host-a", "host-b", "host-c"]);
    expect(groups.other).toEqual([]);
  });

  it("keeps every row across both groups, always", () => {
    for (const arrangement of [
      { occupied: ["host-b"], defaultHostId: "host-a" },
      { occupied: [], defaultHostId: "host-b" },
      { occupied: ["host-c"], defaultHostId: null },
      { occupied: [], defaultHostId: null },
    ]) {
      const groups = groupSweepHostPickerRows(rows(arrangement));
      // Grouping is presentation. It may never drop a host - that is the
      // completeness backstop the picker exists to hold.
      expect([...ids(groups.primary), ...ids(groups.other)].sort()).toEqual([
        "host-a",
        "host-b",
        "host-c",
      ]);
    }
  });
});

describe("host id stamps", () => {
  it("round-trips the SET, dropping absent ids", () => {
    // Legacy chats predating `Chat.hostId` contribute nothing rather than
    // falling back to whichever host the app happens to be pointed at.
    const stamp = stampHostIds(["host-b", null, "host-a", "host-b"]);
    expect(parseHostIdStamp(stamp)).toEqual(["host-a", "host-b"]);
  });

  it("is equal by VALUE for the same set in any order", () => {
    // The whole reason it exists: the projection churns on every title and
    // `updatedAt`, and an unstable set identity would re-render the picker.
    expect(stampHostIds(["host-b", "host-a"])).toBe(
      stampHostIds(["host-a", "host-b", "host-a"]),
    );
  });
});
