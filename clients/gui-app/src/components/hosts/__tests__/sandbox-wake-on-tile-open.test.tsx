import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { SandboxVerbGesture } from "@traycer/protocol/host/sandbox-control";

const mocks = vi.hoisted(() => ({
  opened: true,
  hasRuntime: true,
  wake: vi.fn<(hostId: string, gesture: SandboxVerbGesture | null) => void>(),
}));

vi.mock("@/hooks/sandboxes/use-sandbox-wake-on-tile-open", () => ({
  useSandboxWakeForOpenedTile: (
    hostId: string,
    gesture: SandboxVerbGesture | null,
  ) => mocks.wake(hostId, gesture),
}));
vi.mock("@/lib/canvas/tile-open/tile-open-provenance", () => ({
  useTileOpenRequested: () => mocks.opened,
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => (mocks.hasRuntime ? {} : null),
}));

import { SandboxWakeOnTileOpen } from "@/components/hosts/sandbox-wake-on-tile-open";

beforeEach(() => {
  mocks.opened = true;
  mocks.hasRuntime = true;
  mocks.wake.mockClear();
});
afterEach(cleanup);

describe("<SandboxWakeOnTileOpen />", () => {
  it("mounts the wake for the tile's host when the tile was opened and a host runtime is above it", () => {
    const { container } = render(
      <SandboxWakeOnTileOpen
        hostId="host-sbx-1"
        instanceId="tile-1"
        gesture={null}
      />,
    );

    expect(mocks.wake).toHaveBeenCalledWith("host-sbx-1", null);
    expect(container.innerHTML).toBe("");
  });

  it("hands the wake the gesture the tile gives it", () => {
    render(
      <SandboxWakeOnTileOpen
        hostId="host-sbx-1"
        instanceId="tile-1"
        gesture="open-terminal"
      />,
    );

    expect(mocks.wake).toHaveBeenCalledWith("host-sbx-1", "open-terminal");
  });

  it("renders nothing and never calls the wake with no host runtime above the tile", () => {
    mocks.hasRuntime = false;
    const { container } = render(
      <SandboxWakeOnTileOpen
        hostId="host-sbx-1"
        instanceId="tile-1"
        gesture={null}
      />,
    );

    expect(mocks.wake).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("never calls the wake for a tile a layout restored, runtime or not", () => {
    mocks.opened = false;
    render(
      <SandboxWakeOnTileOpen
        hostId="host-sbx-1"
        instanceId="tile-1"
        gesture={null}
      />,
    );

    expect(mocks.wake).not.toHaveBeenCalled();
  });
});
