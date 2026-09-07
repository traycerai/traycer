import { describe, expect, it } from "vitest";
import type { HostHealth } from "@/components/settings/host-scope/host-health";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  buildSweepHostPickerRows,
  countTaskWorktrees,
  namesHostOutsideSurface,
  sweepHostCountLabel,
  sweepNeedsHostPicker,
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

describe("buildSweepHostPickerRows", () => {
  it("keeps every host, flat, marking only the surface's default", () => {
    const rows = buildSweepHostPickerRows({
      hosts: [hostOption("host-a"), hostOption("host-b"), hostOption("host-c")],
      defaultHostId: "host-a",
    });

    // Never filtered and never grouped: a host with no record naming it can
    // still hold the Task's worktrees, and the shared picker's own order is
    // the order.
    expect(rows.map((row) => row.host.hostId)).toEqual([
      "host-a",
      "host-b",
      "host-c",
    ]);
    expect(rows.map((row) => row.isDefault)).toEqual([true, false, false]);
  });

  it("marks no default when the surface has no host", () => {
    const rows = buildSweepHostPickerRows({
      hosts: [hostOption("host-a")],
      defaultHostId: null,
    });
    expect(rows[0].isDefault).toBe(false);
  });
});

describe("countTaskWorktrees", () => {
  const owner = (epicId: string, ownerKind: "chat" | "terminal-agent") => ({
    epicId,
    ownerKind,
    ownerId: `${ownerKind}-${epicId}`,
    updatedAt: 0,
  });

  it("counts a worktree once however many selected owners share it", () => {
    // Two chats and a terminal agent on one worktree: one worktree.
    expect(
      countTaskWorktrees(
        [
          {
            owners: [
              owner("epic-1", "chat"),
              owner("epic-1", "chat"),
              owner("epic-1", "terminal-agent"),
            ],
          },
        ],
        new Set(["epic-1"]),
      ),
    ).toBe(1);
  });

  it("counts terminal-agent worktrees, which the old badge missed", () => {
    expect(
      countTaskWorktrees(
        [{ owners: [owner("epic-1", "terminal-agent")] }],
        new Set(["epic-1"]),
      ),
    ).toBe(1);
  });

  it("ignores worktrees owned only by unselected Tasks, and orphans", () => {
    expect(
      countTaskWorktrees(
        [
          { owners: [owner("epic-2", "chat")] },
          { owners: [] },
          { owners: [owner("epic-1", "chat"), owner("epic-2", "chat")] },
        ],
        new Set(["epic-1"]),
      ),
    ).toBe(1);
  });
});

describe("sweepHostCountLabel", () => {
  it("keeps the word and the number", () => {
    expect(sweepHostCountLabel(1)).toBe("1 worktree");
    expect(sweepHostCountLabel(3)).toBe("3 worktrees");
  });

  it("renders nothing for zero and for unknown alike", () => {
    // "No number" covers zero, loading, failed and unreachable, so a row
    // never claims a zero it has not proven.
    expect(sweepHostCountLabel(0)).toBeNull();
    expect(sweepHostCountLabel(null)).toBeNull();
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
