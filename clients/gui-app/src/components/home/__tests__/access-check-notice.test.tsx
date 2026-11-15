import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AccessCheckNotice } from "@/components/home/access-check-notice";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  clearHostDoorState,
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";

const HOST_ID = "host-a";

function selectHost(hostId: string): void {
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: hostId,
      targetHostId: hostId,
      effectiveHostId: hostId,
      leases: [{ hostId, status: "ready", dead: null }],
      selectionRevision: 1,
    });
  });
}

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
  useHostDoorStateStore.setState({ byHost: new Map() });
});

describe("<AccessCheckNotice />", () => {
  it("shows board C2's one line, with no button, while the window's host has delayed access checks, and goes when they clear", () => {
    selectHost(HOST_ID);
    act(() => {
      noteHostDoorState({
        hostId: HOST_ID,
        kind: "access-check-delayed",
        detail: null,
      });
    });
    render(<AccessCheckNotice />);

    expect(screen.getByRole("status").textContent).toBe(
      "Access checks are delayed. You can keep working.",
    );
    expect(screen.queryByRole("button")).toBeNull();

    act(() => {
      clearHostDoorState(HOST_ID);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing for another host's delayed access checks", () => {
    selectHost(HOST_ID);
    act(() => {
      noteHostDoorState({
        hostId: "host-b",
        kind: "access-check-delayed",
        detail: null,
      });
    });
    render(<AccessCheckNotice />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});
