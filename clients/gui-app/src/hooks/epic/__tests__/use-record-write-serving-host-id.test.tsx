import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useRecordWriteServingHostId } from "@/hooks/epic/use-epic-record-mutation-client";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "session",
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/lib/host/local-host-id-snapshot", () => ({
  readLocalHostIdSnapshot: () => null,
}));

const METHOD = "epic.setChatArchived";

/** The sidebar's archive gate: the serving host's manifest, fail-closed. */
function useArchiveGate(ownerHostId: string): boolean {
  const servingHostId = useRecordWriteServingHostId(ownerHostId, METHOD);
  return useHostSupportsMethod(servingHostId, METHOD);
}

describe("useRecordWriteServingHostId - the archive gate's host", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
    useSelectionAuthorityStore.setState({
      attached: true,
      leases: [
        { hostId: "owner", status: "dead", dead: { reason: "offline" } },
        { hostId: "session", status: "ready", dead: null },
      ],
    });
  });

  afterEach(() => {
    useSelectionAuthorityStore.getState().reset();
    resetNegotiatedManifests();
  });

  it("offers archive for an owner that is down and never handshook with this renderer, once the stand-in proves the write", () => {
    const { result } = renderHook(() => ({
      servingHostId: useRecordWriteServingHostId("owner", METHOD),
      gate: useArchiveGate("owner"),
    }));
    // No evidence from any stand-in yet: the owner, whose manifest is unknown,
    // so the control stays hidden.
    expect(result.current).toEqual({ servingHostId: "owner", gate: false });

    act(() => {
      recordNegotiatedHostManifest("session", {
        [METHOD]: { major: 1, minor: 1, supportedMajors: [1] },
      });
    });

    expect(result.current).toEqual({ servingHostId: "session", gate: true });
  });

  it("keeps the control hidden while the only stand-in negotiated the owner-only minor", () => {
    recordNegotiatedHostManifest("session", {
      [METHOD]: { major: 1, minor: 0, supportedMajors: [1] },
    });
    const { result } = renderHook(() => useArchiveGate("owner"));
    expect(result.current).toBe(false);
  });

  it("follows the owner again when its lease comes back", () => {
    recordNegotiatedHostManifest("session", {
      [METHOD]: { major: 1, minor: 1, supportedMajors: [1] },
    });
    const { result } = renderHook(() =>
      useRecordWriteServingHostId("owner", METHOD),
    );
    expect(result.current).toBe("session");

    act(() => {
      useSelectionAuthorityStore.setState({
        leases: [
          { hostId: "owner", status: "ready", dead: null },
          { hostId: "session", status: "ready", dead: null },
        ],
      });
    });

    expect(result.current).toBe("owner");
  });
});
