/**
 * `useSurfaceHostPin` / `useSurfaceHostPinWithDefault` (task-default
 * addendum): a task panel (git-diff, pull-requests, file-tree, new-terminal,
 * browsers) resolves the sole host named by its task's GUI chats and
 * terminal agents ({@link useEpicNodeHostIds}) BEFORE `effective` - and,
 * for the panels with their own caller-supplied default (pull-requests, the
 * canvas host), the task default precedes that fallback too, which in turn
 * precedes `effective`. Composers never get one.
 *
 * `resolvedFrom` is only on {@link SurfaceHostPinWithDefault}, so a case that
 * asserts which tier answered renders through `useSurfaceHostPinWithDefault`
 * (with `null` where no caller default applies) rather than the base
 * `useSurfaceHostPin`; cases that only care about `resolvedHostId` use
 * whichever of the two the production call site actually uses.
 *
 * The selection STORE and the selection-authority store are both real
 * (`resetForTests()` / `reset()` between cases): `use-surface-host-pin.ts`
 * reads leases and attach state directly off `useSelectionAuthorityStore`
 * (a `useShallow` selector over it), not through a `useHostLeases()` /
 * `useSelectionAuthorityAttached()` wrapper hook, so seeding those wrapper
 * hooks would no longer reach the resolver at all. Only the two boundary
 * reads a panel cannot control in a unit test - the task's node hosts and
 * the effective host - are mocked, exactly the seam `use-surface-host-pin.ts`
 * itself draws them at.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";

const boundary = vi.hoisted(() => ({
  nodeHostIds: new Set<string>(),
  effectiveHostId: "effective-host" as string | null,
}));

vi.mock("@/hooks/epic/use-epic-node-host-ids", () => ({
  useEpicNodeHostIds: () => boundary.nodeHostIds,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => boundary.effectiveHostId,
}));
// Not exercised by the resolver itself (only by `useSurfaceHostClient`,
// which none of these cases call), stubbed so the module import needs no
// host-client provider.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

import {
  useSurfaceHostPin,
  useSurfaceHostPinWithDefault,
} from "@/hooks/host/use-surface-host-pin";
import {
  composerSurfaceKey,
  newConversationSurfaceKey,
  tabSurfaceKey,
  useSurfaceHostSelectionStore,
  type SurfaceKind,
} from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const TASK_PANEL_KINDS = [
  "git-diff",
  "pull-requests",
  "file-tree",
  "new-terminal",
  "browsers",
] as const satisfies ReadonlyArray<SurfaceKind>;

function panelKey(kind: (typeof TASK_PANEL_KINDS)[number]): string {
  return tabSurfaceKey(kind, "tile-1");
}

function ready(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "ready", dead: null };
}
function restartingExpected(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "restarting-expected", dead: null };
}
function dead(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "dead", dead: { reason: "offline" } };
}

/** Publishes leases onto the REAL authority store, exactly as the fleet
 * bridge would - this is the seam `use-surface-host-pin.ts` now reads. */
function seedLeases(leases: HostLeaseSnapshot[]): void {
  useSelectionAuthorityStore.setState({ leases });
}
function seedAuthorityAttached(attached: boolean): void {
  useSelectionAuthorityStore.setState({ attached });
}

function resetStore(): void {
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
}

beforeEach(() => {
  boundary.nodeHostIds = new Set();
  boundary.effectiveHostId = "effective-host";
  resetStore();
});

afterEach(() => {
  cleanup();
  resetStore();
});

describe("task-default resolution", () => {
  it.each(TASK_PANEL_KINDS)(
    "defaults an unpinned %s panel to the task's sole agent host",
    (kind) => {
      boundary.nodeHostIds = new Set(["task-host"]);
      const { result } = renderHook(() =>
        useSurfaceHostPinWithDefault(panelKey(kind), null),
      );
      expect(result.current.resolvedHostId).toBe("task-host");
      expect(result.current.resolvedFrom).toBe("default");
      expect(result.current.isPinned).toBe(false);
    },
  );

  it("falls back to effective when the task has no agent hosts", () => {
    boundary.nodeHostIds = new Set();
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("git-diff"), null),
    );
    expect(result.current.resolvedHostId).toBe("effective-host");
    expect(result.current.resolvedFrom).toBe("effective");
  });

  it("falls back to effective when the task spans multiple agent hosts", () => {
    boundary.nodeHostIds = new Set(["host-a", "host-b"]);
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("file-tree"), null),
    );
    expect(result.current.resolvedHostId).toBe("effective-host");
    expect(result.current.resolvedFrom).toBe("effective");
  });

  it("precedes the caller's own default (pull-requests' canvas host) with a sole task host", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("pull-requests"), "canvas-host"),
    );
    expect(result.current.resolvedHostId).toBe("task-host");
    expect(result.current.resolvedFrom).toBe("default");
  });

  it("keeps the caller's own default when the task has zero or multiple agent hosts", () => {
    const surfaceKey = panelKey("pull-requests");
    for (const nodeHostIds of [new Set<string>(), new Set(["a", "b"])]) {
      boundary.nodeHostIds = nodeHostIds;
      const { result, unmount } = renderHook(() =>
        useSurfaceHostPinWithDefault(surfaceKey, "canvas-host"),
      );
      expect(result.current.resolvedHostId).toBe("canvas-host");
      unmount();
    }
  });

  it("never applies a task default to the composer or new-conversation pin", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    const composerResult = renderHook(() =>
      useSurfaceHostPin(composerSurfaceKey(null)),
    ).result.current;
    expect(composerResult.resolvedHostId).toBe("effective-host");

    const conversationResult = renderHook(() =>
      useSurfaceHostPinWithDefault(
        newConversationSurfaceKey("epic-1"),
        "epic-host",
      ),
    ).result.current;
    expect(conversationResult.resolvedHostId).toBe("epic-host");
  });

  it("never persists the derived task default as a pin", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    const surfaceKey = panelKey("new-terminal");
    renderHook(() => useSurfaceHostPin(surfaceKey));
    expect(
      useSurfaceHostSelectionStore.getState().selections[surfaceKey],
    ).toBeUndefined();
  });
});

/**
 * `pull-requests` is the one panel with all four tiers live at once: an
 * explicit pin, the task's sole agent host, the caller's own canvas-host
 * default, and finally `effective`. `[taskHostId, defaultHostId].find(...)`
 * in `use-surface-host-pin.ts` walks exactly this chain, applying the same
 * lease rule to each candidate in turn.
 */
describe("the pull-requests four-tier chain (pin, task default, canvas default, effective)", () => {
  it("falls from a dead sole task host through to a live canvas default", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    seedLeases([dead("task-host"), ready("canvas-host")]);
    seedAuthorityAttached(true);
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("pull-requests"), "canvas-host"),
    );
    expect(result.current.resolvedHostId).toBe("canvas-host");
    expect(result.current.resolvedFrom).toBe("default");
    expect(result.current.followingHostId).toBe("canvas-host");
  });

  it("falls from a sole task host absent from a known fleet through to a live canvas default", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    // The fleet HAS spoken (attached, non-empty leases), but none of them
    // names "task-host" - `isSurfacePinDeposed` treats a host missing from a
    // known fleet the same as a dead one, not as "unknown yet".
    seedLeases([ready("canvas-host")]);
    seedAuthorityAttached(true);
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("pull-requests"), "canvas-host"),
    );
    expect(result.current.resolvedHostId).toBe("canvas-host");
    expect(result.current.resolvedFrom).toBe("default");
    expect(result.current.followingHostId).toBe("canvas-host");
  });

  it("falls from a dead task host AND a dead canvas default all the way to effective", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    seedLeases([dead("task-host"), dead("canvas-host")]);
    seedAuthorityAttached(true);
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("pull-requests"), "canvas-host"),
    );
    expect(result.current.resolvedHostId).toBe("effective-host");
    expect(result.current.resolvedFrom).toBe("effective");
    expect(result.current.followingHostId).toBe("effective-host");
  });
});

describe("pin precedence over the task default and effective", () => {
  it("honors an explicit pin over a sole task host, and reports the task host as `followingHostId`", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    seedLeases([ready("task-host"), ready("pinned-host")]);
    seedAuthorityAttached(true);
    const surfaceKey = panelKey("file-tree");
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(surfaceKey, "pinned-host");
    });

    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(surfaceKey, null),
    );
    expect(result.current.resolvedHostId).toBe("pinned-host");
    expect(result.current.resolvedFrom).toBe("pin");
    // What unpinning would move to - the task default, not `effective`.
    expect(result.current.followingHostId).toBe("task-host");
  });

  it("falls through a dead task host to effective, honoring the same lease rule as a pin", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    seedLeases([dead("task-host")]);
    seedAuthorityAttached(true);
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("git-diff"), null),
    );
    expect(result.current.resolvedHostId).toBe("effective-host");
    expect(result.current.resolvedFrom).toBe("effective");
  });

  it("holds a task default through an expected restart, exactly as a pin does", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    seedLeases([restartingExpected("task-host")]);
    seedAuthorityAttached(true);
    const { result } = renderHook(() =>
      useSurfaceHostPinWithDefault(panelKey("browsers"), null),
    );
    expect(result.current.resolvedHostId).toBe("task-host");
    expect(result.current.resolvedFrom).toBe("default");
  });

  it("holds an explicit pin through an expected restart", () => {
    seedLeases([restartingExpected("pinned-host")]);
    seedAuthorityAttached(true);
    const surfaceKey = panelKey("git-diff");
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(surfaceKey, "pinned-host");
    });
    const { result } = renderHook(() => useSurfaceHostPin(surfaceKey));
    expect(result.current.resolvedHostId).toBe("pinned-host");
  });
});

describe("recovery and deregistration", () => {
  it("returns to a dead-then-revived pin with no user action, and never cleared it by death", () => {
    const surfaceKey = panelKey("file-tree");
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(surfaceKey, "pinned-host");
    });
    seedLeases([dead("pinned-host")]);
    seedAuthorityAttached(true);

    const { result, rerender } = renderHook(() =>
      useSurfaceHostPin(surfaceKey),
    );
    expect(result.current.resolvedHostId).toBe("effective-host");
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      "pinned-host",
    );

    act(() => {
      seedLeases([ready("pinned-host")]);
    });
    rerender();
    expect(result.current.resolvedHostId).toBe("pinned-host");
  });

  it("falls a dead pin through to a live task host, not merely effective, then revives to the pin", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    const surfaceKey = panelKey("file-tree");
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(surfaceKey, "pinned-host");
    });
    seedLeases([dead("pinned-host"), ready("task-host")]);
    seedAuthorityAttached(true);

    const { result, rerender } = renderHook(() =>
      useSurfaceHostPinWithDefault(surfaceKey, null),
    );
    // The task default sits between a deposed pin and `effective` - a dead
    // pin must not skip past a live task host straight to `effective`.
    expect(result.current.resolvedHostId).toBe("task-host");
    expect(result.current.resolvedFrom).toBe("default");
    expect(result.current.followingHostId).toBe("task-host");
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      "pinned-host",
    );

    act(() => {
      seedLeases([ready("pinned-host"), ready("task-host")]);
    });
    rerender();
    expect(result.current.resolvedHostId).toBe("pinned-host");
    expect(result.current.resolvedFrom).toBe("pin");
  });

  it("clears a pin whose host left the fleet, and does not resurrect it on the next render", () => {
    const surfaceKey = panelKey("git-diff");
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(surfaceKey, "gone-host");
    });
    seedLeases([ready("effective-host")]);
    seedAuthorityAttached(true);

    const { result, rerender } = renderHook(() =>
      useSurfaceHostPin(surfaceKey),
    );
    expect(
      useSurfaceHostSelectionStore.getState().selections[surfaceKey],
    ).toBeUndefined();
    expect(result.current.resolvedHostId).toBe("effective-host");

    rerender();
    expect(result.current.isPinned).toBe(false);
  });

  it("does not clear a pin before the fleet has spoken (authority not yet attached)", () => {
    const surfaceKey = panelKey("git-diff");
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(surfaceKey, "pinned-host");
    });
    seedAuthorityAttached(false);
    seedLeases([]);

    renderHook(() => useSurfaceHostPin(surfaceKey));
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      "pinned-host",
    );
  });
});

describe("reactivity", () => {
  it("re-resolves as the task's agent hosts change across renders", () => {
    const surfaceKey = panelKey("file-tree");
    boundary.nodeHostIds = new Set(["host-a"]);
    const { result, rerender } = renderHook(() =>
      useSurfaceHostPin(surfaceKey),
    );
    expect(result.current.resolvedHostId).toBe("host-a");

    boundary.nodeHostIds = new Set(["host-a", "host-b"]);
    rerender();
    expect(result.current.resolvedHostId).toBe("effective-host");

    boundary.nodeHostIds = new Set(["host-b"]);
    rerender();
    expect(result.current.resolvedHostId).toBe("host-b");
  });

  it("latches to the task default only when the surface asks, never implicitly", () => {
    boundary.nodeHostIds = new Set(["task-host"]);
    const surfaceKey = panelKey("new-terminal");
    const { result } = renderHook(() => useSurfaceHostPin(surfaceKey));
    expect(
      useSurfaceHostSelectionStore.getState().selections[surfaceKey],
    ).toBeUndefined();

    act(() => result.current.latchOnFirstUse());
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      "task-host",
    );
  });
});
