import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicConversationPlacement } from "@/hooks/host/use-composer-placement";
import {
  composerSurfaceKey,
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The in-Epic new-conversation modal's placement (user ruling 2026-08-18,
 * Codex #1243 T-48): the landing composer's chip pattern, resolved per EPIC
 * with a memory tier -
 *
 *     override ?? pin(epic) ?? Epic session's host ?? effective
 *
 * where `pin(epic)` is that Epic's "last created chat's host" (written by the
 * picker, re-recorded by every create). These pin the TIERS and the KEY: which
 * host answers in each state, that the per-Epic pin is per Epic (two Epics,
 * two memories; the landing composer's window pin untouched), and that only
 * the `effective` tier reports itself as following a derivation move.
 *
 * Same harness as `composer-placement-freeze.test.tsx`: the pin store and the
 * authority store are real; only the client resolver, the effective pointer
 * and the directory are stubbed at their hook seams.
 */

vi.mock("@/lib/browser-tab-identity", () => ({
  browserTabId: () => "tab-test",
  subscribeBrowserTabId: () => () => {},
}));

const mocks = vi.hoisted(() => ({
  effectiveHostId: { current: "host-effective" },
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => ({
    getActiveHostId: () => hostId ?? "app-wide-mutable",
  }),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.effectiveHostId.current,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Studio Mac",
    unavailability: null,
  }),
  useRemoteSessionPollReadiness: () => true,
}));

const EPIC_A = "epic-a";
const EPIC_B = "epic-b";

function publishFleet(
  leases: ReadonlyArray<{
    readonly hostId: string;
    readonly status: "ready" | "dead";
  }>,
  effectiveHostId: string,
): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: effectiveHostId,
    targetHostId: effectiveHostId,
    effectiveHostId,
    // Built per ARM, not with a conditional field: `HostLeaseSnapshot` is a
    // discriminated union, and a mapped object with a `"ready" | "dead"` status
    // is neither member.
    leases: leases.map((lease) =>
      lease.status === "dead"
        ? { hostId: lease.hostId, status: "dead", dead: { reason: "offline" } }
        : { hostId: lease.hostId, status: "ready", dead: null },
    ),
    selectionRevision: 1,
  });
  mocks.effectiveHostId.current = effectiveHostId;
}

beforeEach(() => {
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
  mocks.effectiveHostId.current = "host-effective";
});

afterEach(() => {
  cleanup();
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
});

describe("useEpicConversationPlacement", () => {
  it("resolves the Epic session's host when nothing is pinned - not effective", () => {
    // The default tier. Before this, the modal resolved `pin ?? effective`
    // through the landing composer's window pin, so a new agent in an Epic
    // served from host-session opened on host-effective.
    const { result } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_A,
        overrideHostId: null,
        sessionHostId: "host-session",
      }),
    );

    expect(result.current.target.resolvedHostId).toBe("host-session");
    expect(result.current.submitTarget.client?.getActiveHostId()).toBe(
      "host-session",
    );
    // The READ client too - not only the frozen submit client. The read
    // client used to be keyed on `pin.honoredSelection`, which is null on the
    // default tier as well as on the effective one, so every read (folder
    // picker, harness/model catalog, workspace seed) went to the app-wide
    // host while the chip, the staging key and the create all named the
    // session host: a chat created on one machine carrying folders that exist
    // only on the other. Under this file's mock the app-wide client answers
    // "app-wide-mutable", which is what this arm rules out.
    expect(result.current.target.client?.getActiveHostId()).toBe(
      "host-session",
    );
    expect(result.current.pin.isPinned).toBe(false);
    // Resting on the Epic's host: a derivation move does not re-point it.
    expect(result.current.followsEffective).toBe(false);
  });

  it("falls through to effective, and FOLLOWS it, when there is no session host", () => {
    const { result } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_A,
        overrideHostId: null,
        sessionHostId: null,
      }),
    );

    expect(result.current.target.resolvedHostId).toBe("host-effective");
    expect(result.current.followsEffective).toBe(true);
  });

  it("the per-Epic pin - the last created chat's host - outranks the session's host", () => {
    // What a create records (`recordPlacement`) and what the picker writes:
    // the same per-Epic key. Once written, the modal opens on it.
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(newConversationSurfaceKey(EPIC_A), "host-last-created");
    });
    const { result } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_A,
        overrideHostId: null,
        sessionHostId: "host-session",
      }),
    );

    expect(result.current.target.resolvedHostId).toBe("host-last-created");
    expect(result.current.pin.isPinned).toBe(true);
    expect(result.current.followsEffective).toBe(false);
  });

  it("keys the memory per EPIC: another Epic's pin, and the window's landing pin, are not this Epic's", () => {
    // The mechanism the whole change turns on. The modal used to share the
    // landing composer's WINDOW-keyed pin, so a pick in one Epic moved every
    // other Epic's default and the landing chip with it. Two Epics, one
    // window: two memories, and the landing pin untouched by both.
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(newConversationSurfaceKey(EPIC_B), "host-b-memory");
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(composerSurfaceKey("tab-test"), "host-landing-pin");
    });
    const { result: epicA } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_A,
        overrideHostId: null,
        sessionHostId: "host-session",
      }),
    );
    const { result: epicB } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_B,
        overrideHostId: null,
        sessionHostId: "host-session",
      }),
    );

    // Epic A has no memory of its own: the session's host, not B's memory and
    // not the landing pin.
    expect(epicA.current.target.resolvedHostId).toBe("host-session");
    expect(epicA.current.pin.isPinned).toBe(false);
    // Epic B opens on its own memory.
    expect(epicB.current.target.resolvedHostId).toBe("host-b-memory");

    // Writing A's memory through the placement's own pin lands under A's key
    // and nowhere else.
    act(() => {
      epicA.current.pin.setSelection("host-a-memory");
    });
    const selections = useSurfaceHostSelectionStore.getState().selections;
    expect(selections[newConversationSurfaceKey(EPIC_A)]).toBe("host-a-memory");
    expect(selections[newConversationSurfaceKey(EPIC_B)]).toBe("host-b-memory");
    expect(selections[composerSurfaceKey("tab-test")]).toBe("host-landing-pin");
  });

  it("a caller-NAMED host outranks every tier and freezes the picker (§55)", () => {
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(newConversationSurfaceKey(EPIC_A), "host-last-created");
    });
    const { result } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_A,
        overrideHostId: "host-named",
        sessionHostId: "host-session",
      }),
    );

    expect(result.current.target.resolvedHostId).toBe("host-named");
    expect(result.current.target.isPinned).toBe(true);
    expect(result.current.followsEffective).toBe(false);
  });

  it("a DEAD memory host auto-follows to the session's host, and returns when it is usable again", () => {
    // The pin's death rule, one tier down and then one more: the memory
    // survives the death (sticky return), the resolution moves to the next
    // usable tier - the session's host, NOT straight to effective.
    act(() => {
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(newConversationSurfaceKey(EPIC_A), "host-last-created");
      publishFleet(
        [
          { hostId: "host-last-created", status: "dead" },
          { hostId: "host-session", status: "ready" },
          { hostId: "host-effective", status: "ready" },
        ],
        "host-effective",
      );
    });
    const { result } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_A,
        overrideHostId: null,
        sessionHostId: "host-session",
      }),
    );

    expect(result.current.pin.selection).toBe("host-last-created");
    expect(result.current.pin.honoredSelection).toBeNull();
    expect(result.current.target.resolvedHostId).toBe("host-session");
    expect(result.current.followsEffective).toBe(false);

    act(() => {
      publishFleet(
        [
          { hostId: "host-last-created", status: "ready" },
          { hostId: "host-session", status: "ready" },
          { hostId: "host-effective", status: "ready" },
        ],
        "host-effective",
      );
    });
    expect(result.current.target.resolvedHostId).toBe("host-last-created");
  });

  it("a DEAD session host falls through to effective, and then FOLLOWS it", () => {
    // Death is judged for the default tier on the pin's own rule
    // (`isSurfacePinDeposed`), so "cannot serve" means one thing across all
    // three tiers - and once effective is the answer, the modal is a
    // following surface (G4 applies).
    act(() => {
      publishFleet(
        [
          { hostId: "host-session", status: "dead" },
          { hostId: "host-effective", status: "ready" },
        ],
        "host-effective",
      );
    });
    const { result } = renderHook(() =>
      useEpicConversationPlacement({
        epicId: EPIC_A,
        overrideHostId: null,
        sessionHostId: "host-session",
      }),
    );

    expect(result.current.target.resolvedHostId).toBe("host-effective");
    expect(result.current.followsEffective).toBe(true);
  });
});
